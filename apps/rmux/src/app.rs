use std::collections::{HashMap, HashSet};

use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Widget, Wrap},
    Frame,
};
use ratatui_rmux::{PaneState, PaneWidget};

use neta_protocol::{
    started_label, status_label, Agent, ConversationBlock, Mission, MissionLead, Snapshot,
};

use crate::hosts::{ScopedTarget as Target, SessionKey};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostChoice {
    pub id: crate::hosts::HostId,
    pub label: String,
}

pub const MACHINE_FORM_FIELDS: usize = 6;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostFormSubmission {
    pub editing: Option<crate::hosts::HostId>,
    pub fields: [String; MACHINE_FORM_FIELDS],
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceChoice {
    pub host_id: crate::hosts::HostId,
    pub workspace_id: String,
    pub name: String,
    pub path: String,
    pub host_label: String,
    pub connected: bool,
    pub running: usize,
    pub needs_you: usize,
}

const BG: Color = Color::Rgb(17, 19, 21);
const TEXT: Color = Color::Rgb(236, 238, 235);
const MUTED: Color = Color::Rgb(165, 173, 179);
const AMBER: Color = Color::Rgb(232, 184, 109);
const RULE: Color = Color::Rgb(54, 59, 64);

fn needs_person(state: &str) -> bool {
    matches!(
        state,
        "blocked" | "failed" | "readyToClose" | "mergedNotClosed"
    )
}

#[derive(Clone)]
enum RowKind {
    Leader,
    Mission(String),
    Agent(String),
    ArchiveGroup,
    ArchivedAgent(String),
    OlderArchives,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StatusFilter {
    All,
    Running,
    NeedsYou,
    Archived,
}

impl StatusFilter {
    fn label(self) -> &'static str {
        match self {
            Self::All => "ALL STATUS",
            Self::Running => "RUNNING",
            Self::NeedsYou => "NEEDS YOU",
            Self::Archived => "ARCHIVED",
        }
    }

    fn next(self) -> Self {
        match self {
            Self::All => Self::Running,
            Self::Running => Self::NeedsYou,
            Self::NeedsYou => Self::Archived,
            Self::Archived => Self::All,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ArchivedConversation {
    pub workspace_id: String,
    pub agent_id: String,
    pub session_id: String,
    pub mission_id: String,
    pub mission_name: String,
    pub agent_name: String,
    pub task: String,
}

#[derive(Clone)]
struct ArchiveRequest {
    id: u64,
    archive: ArchivedConversation,
    cursor: Option<String>,
}

#[derive(Clone, Debug)]
pub struct SavedTranscript {
    pub archive: ArchivedConversation,
    pub blocks: Vec<ConversationBlock>,
    pub prev_cursor: Option<String>,
}

#[derive(Clone, Debug)]
pub struct FollowupPreview {
    pub archive: ArchivedConversation,
    pub host_id: crate::hosts::HostId,
    pub objective: Option<String>,
}

#[derive(Clone)]
struct Row {
    label: String,
    detail: String,
    state: String,
    kind: RowKind,
    date: Option<String>,
}

#[derive(Clone, Default)]
struct TabPresentation {
    workspace: String,
    host: String,
    mission: Option<String>,
    mission_number: Option<u64>,
    actor: String,
    role: String,
    state: String,
    offline: bool,
}

fn row_key(kind: &RowKind) -> String {
    match kind {
        RowKind::Leader => "leader".into(),
        RowKind::Mission(id) => format!("m:{id}"),
        RowKind::Agent(id) => format!("a:{id}"),
        RowKind::ArchiveGroup => "archives".into(),
        RowKind::ArchivedAgent(id) => format!("r:{id}"),
        RowKind::OlderArchives => "older".into(),
    }
}

pub struct App {
    pub snapshot: Option<Snapshot>,
    snapshot_host: Option<crate::hosts::HostId>,
    pub workspace_id: Option<String>,
    pub error: Option<String>,
    pub nav_focused: bool,
    pub copy_view: bool,
    pub picker: bool,
    pub help: bool,
    pub help_scroll: u16,
    pub picker_input: String,
    pub picker_cursor: usize,
    pub picker_path_mode: bool,
    pub workspace_choices: Vec<WorkspaceChoice>,
    pending_workspace: Option<WorkspaceChoice>,
    pub host_picker: bool,
    pub hosts: Vec<HostChoice>,
    pub pending_host: Option<crate::hosts::HostId>,
    pub requested_host: Option<crate::hosts::HostId>,
    pub add_host_form: bool,
    pub editing_host: Option<crate::hosts::HostId>,
    pub add_host_fields: [String; MACHINE_FORM_FIELDS],
    pub add_host_field: usize,
    pub pending_add_host: Option<HostFormSubmission>,
    pub host_discovery_request: Option<u64>,
    pub cancelled_host_discovery: Option<u64>,
    next_host_discovery_request: u64,
    pending_edit_host: Option<crate::hosts::HostId>,
    remove_host_confirmation: Option<HostChoice>,
    pending_remove_host: Option<crate::hosts::HostId>,
    pub selected_host: crate::hosts::HostId,
    live_hosts: HashSet<crate::hosts::HostId>,
    pub pending_open: Option<u64>,
    next_open_request: u64,
    pub cursor: usize,
    pub status_filter: StatusFilter,
    pub pane_area: Rect,
    pub sidebar_area: Rect,
    sidebar_scroll: usize,
    visible_selectable_rows: usize,
    expanded: HashSet<String>,
    pending_target: Option<Target>,
    pub active_target: Option<Target>,
    pub tabs: Vec<Target>,
    tab_presentations: HashMap<SessionKey, TabPresentation>,
    row_hitboxes: Vec<(Rect, usize)>,
    status_filter_hitbox: Option<Rect>,
    tab_hitboxes: Vec<(Rect, SessionKey)>,
    tab_close_hitboxes: Vec<(Rect, SessionKey)>,
    overflow_tab_hitboxes: Vec<(Rect, SessionKey)>,
    overflow_hitbox: Option<Rect>,
    hidden_tab_ids: Vec<SessionKey>,
    pub tab_overflow_open: bool,
    tab_overflow_cursor: usize,
    archived_expanded: bool,
    pub archives: Vec<ArchivedConversation>,
    pub archive_next_cursor: Option<String>,
    archive_load_requested: bool,
    pending_archive: Option<ArchiveRequest>,
    active_archive_request: Option<u64>,
    next_archive_request: u64,
    pub saved_transcript: Option<SavedTranscript>,
    archive_loading: bool,
    saved_scroll: u16,
    pub export_path: Option<String>,
    pending_archive_export: Option<(ArchivedConversation, String)>,
    pub diagnostics_export_path: Option<String>,
    pending_diagnostics_export: Option<String>,
    pub diagnostics_exporting: bool,
    pub fixed_preview: Option<FollowupPreview>,
    followup_objective_requested: bool,
    pending_followup_draft: Option<String>,
}

impl Default for App {
    fn default() -> Self {
        Self {
            snapshot: None,
            snapshot_host: None,
            workspace_id: None,
            error: None,
            nav_focused: false,
            copy_view: false,
            picker: false,
            help: false,
            help_scroll: 0,
            picker_input: String::new(),
            picker_cursor: 0,
            picker_path_mode: false,
            workspace_choices: Vec::new(),
            pending_workspace: None,
            host_picker: false,
            hosts: Vec::new(),
            pending_host: None,
            requested_host: None,
            add_host_form: false,
            editing_host: None,
            add_host_fields: std::array::from_fn(|_| String::new()),
            add_host_field: 0,
            pending_add_host: None,
            host_discovery_request: None,
            cancelled_host_discovery: None,
            next_host_discovery_request: 0,
            pending_edit_host: None,
            remove_host_confirmation: None,
            pending_remove_host: None,
            selected_host: crate::hosts::HostId::local(),
            live_hosts: HashSet::new(),
            pending_open: None,
            next_open_request: 0,
            cursor: 0,
            status_filter: StatusFilter::All,
            pane_area: Rect::default(),
            sidebar_area: Rect::default(),
            sidebar_scroll: 0,
            visible_selectable_rows: 1,
            expanded: HashSet::new(),
            pending_target: None,
            active_target: None,
            tabs: Vec::new(),
            tab_presentations: HashMap::new(),
            row_hitboxes: Vec::new(),
            status_filter_hitbox: None,
            tab_hitboxes: Vec::new(),
            tab_close_hitboxes: Vec::new(),
            overflow_tab_hitboxes: Vec::new(),
            overflow_hitbox: None,
            hidden_tab_ids: Vec::new(),
            tab_overflow_open: false,
            tab_overflow_cursor: 0,
            archived_expanded: false,
            archives: Vec::new(),
            archive_next_cursor: None,
            archive_load_requested: false,
            pending_archive: None,
            active_archive_request: None,
            next_archive_request: 0,
            saved_transcript: None,
            archive_loading: false,
            saved_scroll: 0,
            export_path: None,
            pending_archive_export: None,
            diagnostics_export_path: None,
            pending_diagnostics_export: None,
            diagnostics_exporting: false,
            fixed_preview: None,
            followup_objective_requested: false,
            pending_followup_draft: None,
        }
    }
}

impl App {
    pub fn enter_copy_view(&mut self) {
        self.copy_view = true;
        self.nav_focused = false;
        self.picker = false;
        self.help = false;
        self.tab_overflow_open = false;
        self.clear_copy_view_hitboxes();
    }

    pub fn leave_copy_view(&mut self) {
        self.copy_view = false;
        self.nav_focused = true;
        self.clear_copy_view_hitboxes();
    }

    fn clear_copy_view_hitboxes(&mut self) {
        self.row_hitboxes.clear();
        self.status_filter_hitbox = None;
        self.tab_hitboxes.clear();
        self.tab_close_hitboxes.clear();
        self.overflow_tab_hitboxes.clear();
        self.overflow_hitbox = None;
        self.hidden_tab_ids.clear();
        self.sidebar_area = Rect::default();
    }

    pub fn set_hosts(&mut self, hosts: Vec<HostChoice>) {
        self.hosts = hosts;
    }
    pub fn open_host_picker(&mut self) {
        self.host_picker = true;
        self.picker = true;
        self.picker_cursor = 0;
        self.error = None;
    }
    pub fn take_host(&mut self) -> Option<crate::hosts::HostId> {
        self.pending_host.take()
    }
    pub fn take_add_host(&mut self) -> Option<HostFormSubmission> {
        self.pending_add_host.take()
    }
    pub fn request_edit_selected_host(&mut self) {
        if let Some(host) = self
            .hosts
            .get(self.picker_cursor)
            .filter(|host| host.id != crate::hosts::HostId::local())
        {
            self.pending_edit_host = Some(host.id.clone());
        }
    }
    pub fn take_edit_host(&mut self) -> Option<crate::hosts::HostId> {
        self.pending_edit_host.take()
    }
    pub fn open_edit_host(
        &mut self,
        host_id: crate::hosts::HostId,
        fields: [String; MACHINE_FORM_FIELDS],
    ) {
        self.add_host_form = true;
        self.editing_host = Some(host_id);
        self.add_host_fields = fields;
        self.add_host_field = 0;
        self.error = None;
    }
    pub fn request_remove_selected_host(&mut self) {
        if let Some(host) = self
            .hosts
            .get(self.picker_cursor)
            .filter(|host| host.id != crate::hosts::HostId::local())
        {
            self.remove_host_confirmation = Some(host.clone());
        }
    }
    pub fn remove_confirmation(&self) -> Option<&HostChoice> {
        self.remove_host_confirmation.as_ref()
    }
    pub fn confirm_remove_host(&mut self) {
        self.pending_remove_host = self.remove_host_confirmation.take().map(|host| host.id);
    }
    pub fn cancel_remove_host(&mut self) {
        self.remove_host_confirmation = None;
    }
    pub fn take_remove_host(&mut self) -> Option<crate::hosts::HostId> {
        self.pending_remove_host.take()
    }
    pub fn open_add_host(&mut self) {
        self.add_host_form = true;
        self.editing_host = None;
        self.add_host_fields = std::array::from_fn(|_| String::new());
        self.add_host_field = 0;
        self.error = None;
    }
    pub fn begin_host_discovery(&mut self) -> Option<u64> {
        if self.host_discovery_request.is_some() {
            return None;
        }
        self.next_host_discovery_request = self.next_host_discovery_request.wrapping_add(1);
        self.host_discovery_request = Some(self.next_host_discovery_request);
        Some(self.next_host_discovery_request)
    }
    pub fn finish_host_discovery(&mut self, request: u64) -> bool {
        if self.add_host_form && self.host_discovery_request == Some(request) {
            self.host_discovery_request = None;
            true
        } else {
            false
        }
    }
    pub fn cancel_host_discovery(&mut self) {
        self.cancelled_host_discovery = self.host_discovery_request.take();
    }
    pub fn take_cancelled_host_discovery(&mut self) -> Option<u64> {
        self.cancelled_host_discovery.take()
    }
    pub fn select_host(&mut self, host: crate::hosts::HostId) {
        self.requested_host = None;
        self.selected_host = host;
    }
    pub fn set_live_hosts(&mut self, hosts: HashSet<crate::hosts::HostId>) {
        self.live_hosts = hosts;
    }
    pub fn set_workspace_choices(&mut self, choices: Vec<WorkspaceChoice>) {
        let selected = self
            .filtered_workspaces()
            .get(self.picker_cursor)
            .map(|choice| (choice.host_id.clone(), choice.workspace_id.clone()));
        self.workspace_choices = choices;
        self.picker_cursor = selected
            .and_then(|(host_id, workspace_id)| {
                self.filtered_workspaces().iter().position(|choice| {
                    choice.host_id == host_id && choice.workspace_id == workspace_id
                })
            })
            .unwrap_or_else(|| {
                self.picker_cursor
                    .min(self.filtered_workspaces().len().saturating_sub(1))
            });
    }
    fn selected_host_is_offline(&self) -> bool {
        !self.live_hosts.contains(&self.selected_host)
    }
    pub fn host_header_at(&self, point: (u16, u16)) -> bool {
        let (workspace, machine) = self
            .snapshot
            .as_ref()
            .map(|snapshot| {
                let workspace = snapshot
                    .workspaces
                    .iter()
                    .find(|workspace| Some(&workspace.id) == self.workspace_id.as_ref())
                    .map(|workspace| workspace.name.len())
                    .unwrap_or("Open project".len());
                (workspace, snapshot.machine.name.len())
            })
            .unwrap_or(("Open project".len(), "local".len()));
        let machine_start = 8 + workspace;
        point.1 == 0
            && usize::from(point.0) >= machine_start
            && usize::from(point.0) < machine_start + machine + 7
    }
    pub fn next_open_request(&mut self) -> u64 {
        self.next_open_request = self.next_open_request.wrapping_add(1);
        self.next_open_request
    }
    pub fn begin_open(&mut self, request_id: u64) {
        self.pending_open = Some(request_id);
        self.error = None;
    }
    pub fn finish_open(&mut self, request_id: u64, error: Option<String>) -> bool {
        if self.pending_open != Some(request_id) {
            return false;
        }
        self.pending_open = None;
        if let Some(error) = error {
            self.error = Some(error);
        } else {
            self.error = None;
            self.picker = false;
            self.nav_focused = false;
        }
        true
    }
    pub fn rows_len(&self) -> usize {
        self.rows().len()
    }
    pub fn move_cursor(&mut self, delta: isize) {
        let last = self.rows_len().saturating_sub(1);
        self.cursor = self.cursor.saturating_add_signed(delta).min(last);
    }
    pub fn move_cursor_page(&mut self, delta: isize) {
        self.move_cursor(delta.saturating_mul(self.visible_selectable_rows.max(1) as isize));
    }
    pub fn move_cursor_home(&mut self) {
        self.cursor = 0;
    }
    pub fn move_cursor_end(&mut self) {
        self.cursor = self.rows_len().saturating_sub(1);
    }
    pub fn cycle_status_filter(&mut self) {
        let selected = self.rows().get(self.cursor).map(|row| row_key(&row.kind));
        self.status_filter = self.status_filter.next();
        let rows = self.rows();
        self.cursor = selected
            .and_then(|key| rows.iter().position(|row| row_key(&row.kind) == key))
            .unwrap_or_else(|| self.cursor.min(rows.len().saturating_sub(1)));
    }
    pub fn activate(&mut self) {
        let Some(row) = self.rows().get(self.cursor).cloned() else {
            return;
        };
        match &row.kind {
            RowKind::Leader => {
                self.select_leader();
                self.nav_focused = false;
            }
            RowKind::Mission(id) => {
                if !self.expanded.remove(id) {
                    self.expanded.insert(id.clone());
                }
                self.pending_target = self
                    .snapshot
                    .as_ref()
                    .and_then(|snapshot| snapshot.mission_target(id))
                    .and_then(|target| Target::new(self.selected_host.clone(), target).ok());
                if self.pending_target.is_some() {
                    self.nav_focused = false;
                }
            }
            RowKind::Agent(id) => {
                self.pending_target = self
                    .snapshot
                    .as_ref()
                    .and_then(|snapshot| snapshot.agent_target(id))
                    .and_then(|target| Target::new(self.selected_host.clone(), target).ok());
                self.nav_focused = false;
            }
            RowKind::ArchiveGroup => {
                self.archived_expanded = !self.archived_expanded;
                if self.archived_expanded && self.archives.is_empty() {
                    self.archive_load_requested = true;
                }
            }
            RowKind::OlderArchives => self.archive_load_requested = true,
            RowKind::ArchivedAgent(id) => {
                if let Some(archive) = self
                    .archives
                    .iter()
                    .find(|archive| archive.agent_id == *id)
                    .cloned()
                {
                    self.next_archive_request = self.next_archive_request.wrapping_add(1);
                    self.pending_archive = Some(ArchiveRequest {
                        id: self.next_archive_request,
                        archive,
                        cursor: None,
                    });
                    self.active_archive_request = Some(self.next_archive_request);
                    self.pending_target = None;
                    self.saved_transcript = None;
                    self.archive_loading = true;
                    self.nav_focused = false;
                }
            }
        }
    }
    pub fn expand_selected(&mut self, expand: bool) {
        let Some(Row {
            kind: RowKind::Mission(id),
            ..
        }) = self.rows().get(self.cursor).cloned()
        else {
            return;
        };
        if expand {
            self.expanded.insert(id);
        } else {
            self.expanded.remove(&id);
        }
    }
    pub fn take_target(&mut self) -> Option<Target> {
        self.pending_target.take()
    }
    pub fn take_archive_load(&mut self) -> bool {
        std::mem::take(&mut self.archive_load_requested)
    }
    pub fn take_archive_tail(&mut self) -> Option<(u64, ArchivedConversation, Option<String>)> {
        let request = self.pending_archive.take()?;
        Some((request.id, request.archive, request.cursor))
    }
    pub fn set_archives(
        &mut self,
        workspace_id: &str,
        archives: Vec<ArchivedConversation>,
        next_cursor: Option<String>,
    ) {
        if self.workspace_id.as_deref() != Some(workspace_id) {
            return;
        }
        for archive in archives {
            if !self
                .archives
                .iter()
                .any(|existing| existing.agent_id == archive.agent_id)
            {
                self.archives.push(archive);
            }
        }
        self.archive_next_cursor = next_cursor;
    }
    pub fn set_saved_transcript(
        &mut self,
        request_id: u64,
        archive: ArchivedConversation,
        mut blocks: Vec<ConversationBlock>,
        prev_cursor: Option<String>,
        older: bool,
    ) {
        if self.workspace_id.as_deref() != Some(&archive.workspace_id)
            || self.active_archive_request != Some(request_id)
        {
            return;
        }
        if older {
            if let Some(saved) = &mut self.saved_transcript {
                if saved.archive.agent_id != archive.agent_id {
                    return;
                }
                blocks.append(&mut saved.blocks);
                saved.blocks = blocks;
                saved.prev_cursor = prev_cursor;
                self.archive_loading = false;
                self.saved_scroll = 0;
                return;
            }
        }
        self.archive_loading = false;
        self.saved_scroll = 0;
        self.saved_transcript = Some(SavedTranscript {
            archive,
            blocks,
            prev_cursor,
        });
    }
    pub fn request_older_archive(&mut self) {
        if !self.archive_loading {
            if let Some(saved) = &self.saved_transcript {
                if let Some(cursor) = &saved.prev_cursor {
                    self.next_archive_request = self.next_archive_request.wrapping_add(1);
                    self.pending_archive = Some(ArchiveRequest {
                        id: self.next_archive_request,
                        archive: saved.archive.clone(),
                        cursor: Some(cursor.clone()),
                    });
                    self.active_archive_request = Some(self.next_archive_request);
                    self.archive_loading = true;
                }
            }
        }
    }
    pub fn archive_failed(&mut self, request_id: u64, message: String) {
        if self.active_archive_request == Some(request_id) {
            self.archive_loading = false;
            self.error = Some(message);
        }
    }
    pub fn is_read_only_archive(&self) -> bool {
        self.archive_loading || self.saved_transcript.is_some()
    }
    pub fn scroll_saved(&mut self, delta: isize) {
        let max = self.saved_scroll_limit();
        self.saved_scroll = self
            .saved_scroll
            .saturating_add_signed(delta.clamp(i16::MIN as isize, i16::MAX as isize) as i16)
            .min(max);
    }
    pub fn clear_saved_transcript(&mut self) {
        self.pending_archive = None;
        self.active_archive_request = None;
        self.archive_loading = false;
        self.saved_transcript = None;
        self.saved_scroll = 0;
        self.export_path = None;
        self.fixed_preview = None;
        self.followup_objective_requested = false;
        self.pending_followup_draft = None;
    }

    pub fn begin_followup_preview(&mut self) {
        let Some(saved) = &self.saved_transcript else {
            return;
        };
        self.fixed_preview = Some(FollowupPreview {
            archive: saved.archive.clone(),
            host_id: self.selected_host.clone(),
            objective: None,
        });
        self.followup_objective_requested = true;
    }

    pub fn take_followup_objective_request(
        &mut self,
    ) -> Option<(crate::hosts::HostId, ArchivedConversation)> {
        if !std::mem::take(&mut self.followup_objective_requested) {
            return None;
        }
        self.fixed_preview
            .as_ref()
            .map(|preview| (preview.host_id.clone(), preview.archive.clone()))
    }

    pub fn set_followup_objective(
        &mut self,
        host_id: &crate::hosts::HostId,
        archive: &ArchivedConversation,
        objective: String,
    ) {
        let Some(preview) = &mut self.fixed_preview else {
            return;
        };
        if &preview.host_id == host_id
            && preview.archive.mission_id == archive.mission_id
            && preview.archive.workspace_id == archive.workspace_id
        {
            preview.objective = Some(objective);
        }
    }

    pub fn followup_failed(&mut self, message: String) {
        if self.fixed_preview.is_some() {
            self.error = Some(message);
        }
    }

    pub fn cancel_followup_preview(&mut self) {
        self.fixed_preview = None;
        self.followup_objective_requested = false;
    }

    pub fn submit_followup_preview(&mut self) {
        let Some(preview) = self.fixed_preview.take() else {
            return;
        };
        let Some(objective) = preview.objective else {
            self.error = Some("source mission objective is still loading".into());
            self.fixed_preview = Some(preview);
            return;
        };
        self.pending_followup_draft = Some(format!(
            "Create a new mission with neta_mission. Choose a meaningful name and set its `continues` parameter to `{}`. Use this original objective as context:\n\n> {}\n\nDo not resume the archived session.",
            preview.archive.mission_id, objective
        ));
        self.select_leader();
    }

    pub fn take_followup_draft(&mut self) -> Option<String> {
        self.pending_followup_draft.take()
    }
    pub fn begin_archive_export(&mut self, path: String) {
        if self.saved_transcript.is_some() {
            self.export_path = Some(path);
        }
    }
    pub fn take_archive_export(&mut self) -> Option<(ArchivedConversation, String)> {
        self.pending_archive_export.take()
    }
    pub fn submit_archive_export(&mut self) {
        if let (Some(saved), Some(path)) = (&self.saved_transcript, self.export_path.take()) {
            if path.trim().is_empty() {
                self.error = Some("export path is required".into());
                return;
            }
            self.pending_archive_export = Some((saved.archive.clone(), path));
        }
    }
    pub fn begin_diagnostics_export(&mut self, path: String) {
        if !self.diagnostics_exporting {
            self.diagnostics_export_path = Some(path);
        }
    }
    pub fn submit_diagnostics_export(&mut self) {
        if self.diagnostics_exporting {
            return;
        }
        if let Some(path) = self.diagnostics_export_path.take() {
            if path.trim().is_empty() {
                self.error = Some("export path is required".into());
            } else {
                self.pending_diagnostics_export = Some(path);
                self.diagnostics_exporting = true;
            }
        }
    }
    pub fn take_diagnostics_export(&mut self) -> Option<String> {
        self.pending_diagnostics_export.take()
    }
    pub fn finish_diagnostics_export(&mut self, result: Result<String, String>) {
        self.diagnostics_exporting = false;
        match result {
            Ok(path) => self.error = Some(format!("Exported diagnostics to {path}")),
            Err(error) => self.error = Some(format!("diagnostics export failed: {error}")),
        }
    }
    pub fn add_tab(&mut self, target: Target) {
        self.clear_saved_transcript();
        if !self.tabs.iter().any(|tab| tab.key == target.key) {
            self.tabs.push(target.clone());
        }
        self.workspace_id = Some(target.workspace_id.clone());
        self.selected_host = target.key.host_id.clone();
        self.active_target = Some(target);
    }

    pub fn sync_tab_presentations(&mut self, host_id: &crate::hosts::HostId, snapshot: &Snapshot) {
        for tab in self.tabs.iter().filter(|tab| &tab.key.host_id == host_id) {
            let mut presentation = TabPresentation {
                workspace: snapshot
                    .workspaces
                    .iter()
                    .find(|workspace| workspace.id == tab.workspace_id)
                    .map(|workspace| workspace.name.clone())
                    .unwrap_or_else(|| tab.workspace_id.clone()),
                host: snapshot.machine.name.clone(),
                actor: tab.name.clone(),
                role: "Unknown role".into(),
                state: "UNKNOWN".into(),
                offline: !self.live_hosts.contains(host_id),
                ..TabPresentation::default()
            };
            if let Some(agent) = snapshot.agents.iter().find(|agent| {
                agent.session_id == tab.session_id
                    && snapshot.missions.iter().any(|mission| {
                        mission.id == agent.mission_id && mission.workspace_id == tab.workspace_id
                    })
            }) {
                presentation.actor = agent.name.clone();
                presentation.state = status_label(&agent.state).into();
                if let Some(mission) = snapshot
                    .missions
                    .iter()
                    .find(|mission| mission.id == agent.mission_id)
                {
                    presentation.mission = Some(mission.name.clone());
                    presentation.mission_number = Some(mission.number);
                    presentation.role = if matches!(&mission.lead, MissionLead::Agent { agent_id } if agent_id == &agent.id)
                    {
                        "Mission lead".into()
                    } else {
                        "Agent".into()
                    };
                }
            } else if let Some(leader) = snapshot.leaders.iter().find(|leader| {
                leader.session_id == tab.session_id && leader.workspace_id == tab.workspace_id
            }) {
                presentation.actor = leader.name.clone();
                presentation.role = "Workspace leader".into();
                presentation.state = status_label(&leader.state).into();
            }
            self.tab_presentations.insert(tab.key.clone(), presentation);
        }
    }

    pub fn mark_tabs_offline(&mut self, host_id: &crate::hosts::HostId) {
        for tab in self.tabs.iter().filter(|tab| &tab.key.host_id == host_id) {
            self.tab_presentations
                .entry(tab.key.clone())
                .or_default()
                .offline = true;
        }
    }
    pub fn select_tab(&mut self, key: &SessionKey) {
        self.clear_saved_transcript();
        if let Some(target) = self.tabs.iter().find(|tab| &tab.key == key).cloned() {
            self.workspace_id = Some(target.workspace_id.clone());
            self.selected_host = target.key.host_id.clone();
            self.active_target = Some(target.clone());
            self.pending_target = Some(target);
            self.tab_overflow_open = false;
        }
    }
    pub fn select_next_tab(&mut self, delta: isize) {
        let Some(active) = &self.active_target else {
            return;
        };
        let Some(index) = self.tabs.iter().position(|tab| tab.key == active.key) else {
            return;
        };
        let next = (index as isize + delta).rem_euclid(self.tabs.len() as isize) as usize;
        let key = self.tabs[next].key.clone();
        self.select_tab(&key);
    }
    pub fn close_active_tab(&mut self) {
        let Some(active) = &self.active_target else {
            return;
        };
        self.close_tab(&active.key.clone());
    }
    pub fn close_tab(&mut self, key: &SessionKey) {
        let Some(index) = self.tabs.iter().position(|tab| &tab.key == key) else {
            return;
        };
        let was_active = self
            .active_target
            .as_ref()
            .is_some_and(|active| &active.key == key);
        self.tabs.remove(index);
        self.tab_presentations.remove(key);
        self.tab_overflow_open = false;
        if !was_active {
            return;
        }
        self.clear_saved_transcript();
        if let Some(next) = self
            .tabs
            .get(index.min(self.tabs.len().saturating_sub(1)))
            .cloned()
        {
            self.workspace_id = Some(next.workspace_id.clone());
            self.selected_host = next.key.host_id.clone();
            self.active_target = Some(next.clone());
            self.pending_target = Some(next);
        } else {
            let leader = self
                .snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.leader_target(self.workspace_id.as_deref()?))
                .and_then(|target| Target::new(self.selected_host.clone(), target).ok());
            self.active_target = leader.clone();
            self.pending_target = leader;
            self.nav_focused = true;
        }
    }
    pub fn tab_at(&self, point: (u16, u16)) -> Option<SessionKey> {
        self.tab_hitboxes
            .iter()
            .find(|(area, _)| area.contains(point.into()))
            .map(|(_, id)| id.clone())
    }
    pub fn tab_close_at(&self, point: (u16, u16)) -> Option<SessionKey> {
        self.tab_close_hitboxes
            .iter()
            .find(|(area, _)| area.contains(point.into()))
            .map(|(_, id)| id.clone())
    }
    pub fn overflow_at(&self, point: (u16, u16)) -> bool {
        self.overflow_hitbox
            .is_some_and(|area| area.contains(point.into()))
    }
    pub fn overflow_tab_at(&self, point: (u16, u16)) -> Option<SessionKey> {
        self.overflow_tab_hitboxes
            .iter()
            .find(|(area, _)| area.contains(point.into()))
            .map(|(_, id)| id.clone())
    }
    pub fn toggle_tab_overflow(&mut self) {
        self.tab_overflow_open = !self.tab_overflow_open;
    }
    pub fn move_overflow_cursor(&mut self, delta: isize) {
        let count = self.hidden_tab_ids.len();
        if count > 0 {
            self.tab_overflow_cursor = self
                .tab_overflow_cursor
                .saturating_add_signed(delta)
                .min(count - 1);
        }
    }
    pub fn select_overflow_cursor(&mut self) {
        if let Some(key) = self.hidden_tab_ids.get(self.tab_overflow_cursor).cloned() {
            self.select_tab(&key);
        }
    }
    pub fn row_at(&self, point: (u16, u16)) -> Option<usize> {
        self.row_hitboxes
            .iter()
            .find(|(area, _)| area.contains(point.into()))
            .map(|(_, index)| *index)
    }
    pub fn status_filter_at(&self, point: (u16, u16)) -> bool {
        self.status_filter_hitbox
            .is_some_and(|area| area.contains(point.into()))
    }
    pub fn picker_move(&mut self, delta: isize) {
        if self.host_picker {
            self.picker_cursor = self
                .picker_cursor
                .saturating_add_signed(delta)
                .min(self.hosts.len());
            return;
        }
        if self.picker_path_mode {
            return;
        }
        let count = self.filtered_workspaces().len();
        self.picker_cursor = self
            .picker_cursor
            .saturating_add_signed(delta)
            .min(count.saturating_sub(1));
    }
    pub fn select_workspace_choice(&mut self) {
        if self.picker_path_mode {
            return;
        }
        self.pending_workspace = self
            .filtered_workspaces()
            .get(self.picker_cursor)
            .map(|choice| (*choice).clone());
    }
    pub fn take_workspace_choice(&mut self) -> Option<WorkspaceChoice> {
        self.pending_workspace.take()
    }
    fn filtered_workspaces(&self) -> Vec<&WorkspaceChoice> {
        if self.picker_path_mode {
            return Vec::new();
        }
        let query = self.picker_input.to_lowercase();
        self.workspace_choices
            .iter()
            .filter(|choice| {
                choice.name.to_lowercase().contains(&query)
                    || choice.path.to_lowercase().contains(&query)
                    || choice.host_label.to_lowercase().contains(&query)
            })
            .collect()
    }
    pub fn select_leader(&mut self) {
        self.pending_target = self
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.leader_target(self.workspace_id.as_deref()?))
            .and_then(|target| Target::new(self.selected_host.clone(), target).ok());
        if self.pending_target.is_some() {
            self.nav_focused = false;
        }
    }
    pub fn refresh_active_target(&mut self) {
        self.pending_target = self.active_target.clone();
        if self.pending_target.is_some() {
            self.nav_focused = false;
        }
    }
    pub fn rebind_active_target(&mut self, host_id: &crate::hosts::HostId, next: &Snapshot) {
        let Some(active) = &self.active_target else {
            return;
        };
        if active.key.host_id != *host_id || self.snapshot_host.as_ref() != Some(host_id) {
            return;
        }
        let replacement = self.snapshot.as_ref().and_then(|current| {
            if current.leaders.iter().any(|leader| {
                leader.workspace_id == active.workspace_id && leader.session_id == active.session_id
            }) {
                return next
                    .leader_target(&active.workspace_id)
                    .and_then(|target| Target::new(active.key.host_id.clone(), target).ok());
            }
            let agent = current.agents.iter().find(|agent| {
                agent.session_id == active.session_id
                    && current.missions.iter().any(|mission| {
                        mission.id == agent.mission_id
                            && mission.workspace_id == active.workspace_id
                    })
            })?;
            next.agent_target(&agent.id)
                .filter(|target| target.workspace_id == active.workspace_id)
                .and_then(|target| Target::new(active.key.host_id.clone(), target).ok())
        });
        if replacement
            .as_ref()
            .is_some_and(|target| target.key != active.key)
        {
            self.pending_target = replacement;
        }
    }
    pub fn replace_snapshot_for_host(
        &mut self,
        host_id: &crate::hosts::HostId,
        snapshot: Snapshot,
    ) {
        let selected = self.rows().get(self.cursor).map(|row| match &row.kind {
            RowKind::Leader => "leader".into(),
            RowKind::Mission(id) => format!("m:{id}"),
            RowKind::Agent(id) => format!("a:{id}"),
            RowKind::ArchiveGroup => "archives".into(),
            RowKind::ArchivedAgent(id) => format!("r:{id}"),
            RowKind::OlderArchives => "older".into(),
        });
        self.rebind_active_target(host_id, &snapshot);
        self.snapshot = Some(snapshot);
        self.snapshot_host = Some(host_id.clone());
        if let Some(selected) = selected {
            if let Some(index) = self.rows().iter().position(|row| match &row.kind {
                RowKind::Leader => selected == "leader",
                RowKind::Mission(id) => selected == format!("m:{id}"),
                RowKind::Agent(id) => selected == format!("a:{id}"),
                RowKind::ArchiveGroup => selected == "archives",
                RowKind::ArchivedAgent(id) => selected == format!("r:{id}"),
                RowKind::OlderArchives => selected == "older",
            }) {
                self.cursor = index;
                return;
            }
        }
        self.cursor = self.cursor.min(self.rows_len().saturating_sub(1));
    }
    #[cfg(test)]
    pub fn replace_snapshot(&mut self, snapshot: Snapshot) {
        self.replace_snapshot_for_host(&self.selected_host.clone(), snapshot);
    }
    fn rows(&self) -> Vec<Row> {
        let Some(snapshot) = &self.snapshot else {
            return Vec::new();
        };
        let mut missions: Vec<&Mission> = snapshot
            .missions
            .iter()
            .filter(|m| Some(&m.workspace_id) == self.workspace_id.as_ref())
            .filter(|mission| match self.status_filter {
                StatusFilter::All => true,
                StatusFilter::Running => mission.state == "running",
                StatusFilter::NeedsYou => needs_person(&mission.state),
                StatusFilter::Archived => false,
            })
            .collect();
        missions.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| b.id.cmp(&a.id))
        });
        let mut rows = Vec::new();
        rows.push(Row {
            label: "● NOW · workspace leader".into(),
            detail: "0 jumps here".into(),
            state: "LIVE".into(),
            kind: RowKind::Leader,
            date: None,
        });
        let mut prior_date = None;
        for mission in missions {
            let open = self.expanded.contains(&mission.id);
            let date = mission
                .created_at
                .get(..10)
                .unwrap_or(&mission.created_at)
                .to_owned();
            let date_group = (prior_date.as_ref() != Some(&date)).then_some(date.clone());
            prior_date = Some(date);
            rows.push(Row {
                label: format!(
                    "{} {} #{} {}",
                    started_label(&mission.created_at),
                    if open { "▾" } else { "▸" },
                    mission.number,
                    mission.name
                ),
                detail: match &mission.attention {
                    Some(attention) => format!("{} agents · {attention}", mission.agent_ids.len()),
                    None => format!("{} agents", mission.agent_ids.len()),
                },
                state: status_label(&mission.state).into(),
                kind: RowKind::Mission(mission.id.clone()),
                date: date_group,
            });
            if open {
                for agent in snapshot
                    .agents
                    .iter()
                    .filter(|agent| agent.mission_id == mission.id)
                {
                    rows.push(agent_row(agent));
                }
            }
        }
        let show_archives = matches!(
            self.status_filter,
            StatusFilter::All | StatusFilter::Archived
        ) && (self.archived_expanded
            || self.status_filter == StatusFilter::Archived);
        rows.push(Row {
            label: format!(
                "{} ARCHIVED · saved conversations",
                if show_archives { "▾" } else { "▸" }
            ),
            detail: String::new(),
            state: "SAVED".into(),
            kind: RowKind::ArchiveGroup,
            date: None,
        });
        if show_archives {
            for archive in self
                .archives
                .iter()
                .filter(|archive| Some(&archive.workspace_id) == self.workspace_id.as_ref())
            {
                rows.push(Row {
                    label: format!("      └ {} · {}", archive.agent_name, archive.mission_name),
                    detail: archive.task.clone(),
                    state: "ARCHIVED".into(),
                    kind: RowKind::ArchivedAgent(archive.agent_id.clone()),
                    date: None,
                });
            }
            if self.archive_next_cursor.is_some() {
                rows.push(Row {
                    label: "      more archived missions…".into(),
                    detail: String::new(),
                    state: "SAVED".into(),
                    kind: RowKind::OlderArchives,
                    date: None,
                });
            }
        }
        rows
    }

    pub fn render(&mut self, frame: &mut Frame<'_>, pane: &PaneState) {
        frame.render_widget(
            Block::default().style(Style::default().bg(BG)),
            frame.area(),
        );
        if self.copy_view {
            self.clear_copy_view_hitboxes();
            self.pane_area = frame.area();
            PaneWidget::new(pane).render(self.pane_area, frame.buffer_mut());
            return;
        }
        let outer = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(3),
                Constraint::Min(8),
                Constraint::Length(2),
            ])
            .split(frame.area());
        self.render_header(frame, outer[0]);
        let body = Self::body_areas(frame.area(), self.nav_focused);
        self.sidebar_area = body[0];
        self.pane_area = body[1].inner(ratatui::layout::Margin {
            horizontal: 1,
            vertical: 1,
        });
        if body[0].width == 0 || body[0].height == 0 {
            self.row_hitboxes.clear();
            self.visible_selectable_rows = 0;
        }
        if body[1].width == 0 || body[1].height == 0 {
            self.tab_hitboxes.clear();
            self.tab_close_hitboxes.clear();
            self.overflow_tab_hitboxes.clear();
            self.overflow_hitbox = None;
            self.hidden_tab_ids.clear();
        }
        self.render_sidebar(frame, body[0]);
        if self.is_read_only_archive() {
            self.render_saved_transcript(frame, body[1]);
        } else if body[1].width > 0 && body[1].height > 0 {
            self.render_pane(frame, body[1], pane);
        } else if self.tab_overflow_open {
            // On compact terminals navigation owns the body, so the normal
            // pane tab strip is hidden.  Keep its tab picker available here:
            // every tab is hidden while the navigation view is visible.
            self.render_compact_tab_overflow(frame, body[0]);
        }
        let compact = frame.area().width < 80;
        let status = if let Some(error) = &self.error {
            clip_label(error, usize::from(frame.area().width.saturating_sub(2)))
        } else if self.picker {
            if self.host_picker {
                if self.add_host_form {
                    " ADD MACHINE · input is captured".into()
                } else if compact {
                    " MACHINE PICKER · input captured".into()
                } else {
                    " MACHINE PICKER · input is captured".into()
                }
            } else if self.picker_path_mode {
                if compact {
                    " PROJECT PATH · input captured".into()
                } else {
                    " PROJECT PATH · input is captured".into()
                }
            } else if compact {
                " WORKSPACE PICKER · input captured".into()
            } else {
                " WORKSPACE PICKER · input is captured".into()
            }
        } else if self.help {
            " HELP OPEN · Esc closes help".into()
        } else if self.fixed_preview.is_some() {
            if compact {
                " FOLLOW-UP · Enter send · Esc cancel".into()
            } else {
                " FOLLOW-UP PREVIEW · Enter sends · Esc cancels".into()
            }
        } else if self.diagnostics_export_path.is_some() {
            " DIAGNOSTICS EXPORT · path input is captured".into()
        } else if self.diagnostics_exporting {
            " DIAGNOSTICS EXPORT · collecting machines in background".into()
        } else if self.export_path.is_some() {
            if compact {
                " ARCHIVE EXPORT · path input captured".into()
            } else {
                " ARCHIVE EXPORT · path input is captured".into()
            }
        } else if self.tab_overflow_open {
            " TAB PICKER · ↑↓ select · Enter opens".into()
        } else if self.is_read_only_archive() {
            " ARCHIVE READ-ONLY · ↑↓ scroll".into()
        } else if self.nav_focused {
            if compact {
                " NAVIGATION · keys navigate".into()
            } else {
                " NAVIGATION FOCUSED · keys navigate spine".into()
            }
        } else if self.selected_host_is_offline() {
            " MACHINE OFFLINE · Pi input paused".into()
        } else {
            " PI FOCUSED · keys go to Pi".into()
        };
        let shortcuts = if compact {
            " Ctrl+Space nav  Ctrl+Q quit"
        } else {
            " Ctrl+Space navigation  Ctrl+K workspaces  F1 help  Ctrl+Q quit"
        };
        frame.render_widget(
            Paragraph::new(vec![
                Line::styled(status, Style::default().fg(AMBER)),
                Line::styled(shortcuts, Style::default().fg(MUTED)),
            ])
            .style(Style::default().bg(BG)),
            outer[2],
        );
        if self.picker {
            self.render_picker(frame);
        }
        if self.diagnostics_export_path.is_some() {
            self.render_diagnostics_export(frame);
        }
        if self.help {
            self.render_help(frame);
        }
    }

    pub fn initial_pane_area(area: Rect) -> Rect {
        let pane = Self::body_areas(area, false)[1].inner(ratatui::layout::Margin {
            horizontal: 1,
            vertical: 1,
        });
        Rect::new(
            pane.x,
            pane.y.saturating_add(1),
            pane.width,
            pane.height.saturating_sub(1),
        )
    }
    fn body_areas(area: Rect, nav_focused: bool) -> std::rc::Rc<[Rect]> {
        let outer = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(3),
                Constraint::Min(8),
                Constraint::Length(2),
            ])
            .split(area);
        if outer[1].width < 80 {
            return Layout::default()
                .direction(Direction::Horizontal)
                .constraints(if nav_focused {
                    [Constraint::Min(0), Constraint::Length(0)]
                } else {
                    [Constraint::Length(0), Constraint::Min(0)]
                })
                .split(outer[1]);
        }
        let sidebar_width = ((outer[1].width as f32 * 0.27) as u16)
            .clamp(24, 44)
            .min(outer[1].width.saturating_sub(20));
        Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Length(sidebar_width), Constraint::Min(20)])
            .split(outer[1])
    }

    fn render_header(&self, frame: &mut Frame<'_>, area: Rect) {
        let (workspace, machine, leader, counts) = self
            .snapshot
            .as_ref()
            .map(|s| {
                let ws = s
                    .workspaces
                    .iter()
                    .find(|w| Some(&w.id) == self.workspace_id.as_ref())
                    .map(|w| w.name.as_str())
                    .unwrap_or("Open project");
                let lead = s
                    .leaders
                    .iter()
                    .find(|l| Some(&l.workspace_id) == self.workspace_id.as_ref())
                    .map(|l| format!("Jump to leader · {} · {}", l.name, status_label(&l.state)))
                    .unwrap_or_else(|| "Open project".into());
                let running = s
                    .missions
                    .iter()
                    .filter(|m| {
                        Some(&m.workspace_id) == self.workspace_id.as_ref() && m.state == "running"
                    })
                    .count();
                let needs = s
                    .missions
                    .iter()
                    .filter(|m| {
                        Some(&m.workspace_id) == self.workspace_id.as_ref()
                            && needs_person(&m.state)
                    })
                    .count();
                (
                    ws,
                    s.machine.name.as_str(),
                    lead,
                    format!("{running} running · {needs} needs you"),
                )
            })
            .unwrap_or((
                "Open project",
                "local",
                "Open project".into(),
                "0 running · 0 needs you".into(),
            ));
        let line = Line::from(vec![
            Span::styled(
                " neta ",
                Style::default()
                    .fg(BG)
                    .bg(AMBER)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw("  "),
            Span::styled(
                workspace,
                Style::default().fg(TEXT).add_modifier(Modifier::BOLD),
            ),
            Span::styled(format!("  {machine} [M]  "), Style::default().fg(MUTED)),
            Span::styled(leader, Style::default().fg(AMBER)),
            Span::styled(format!("    {counts}"), Style::default().fg(MUTED)),
        ]);
        frame.render_widget(
            Paragraph::new(line)
                .block(
                    Block::default()
                        .borders(Borders::BOTTOM)
                        .border_style(Style::default().fg(RULE)),
                )
                .style(Style::default().bg(BG)),
            area,
        );
    }

    fn render_sidebar(&mut self, frame: &mut Frame<'_>, area: Rect) {
        let title = if self.nav_focused {
            " SPINE · NAVIGATION "
        } else {
            " SPINE "
        };
        let inner = area.inner(ratatui::layout::Margin {
            horizontal: 1,
            vertical: 1,
        });
        frame.render_widget(
            Block::default()
                .title(title)
                .borders(Borders::RIGHT)
                .border_style(Style::default().fg(if self.nav_focused { AMBER } else { RULE })),
            area,
        );
        let machine = self
            .snapshot
            .as_ref()
            .map(|snapshot| snapshot.machine.name.as_str())
            .or_else(|| {
                self.hosts
                    .iter()
                    .find(|host| host.id == self.selected_host)
                    .map(|host| host.label.as_str())
            })
            .unwrap_or("local")
            .to_uppercase();
        let filter = if inner.width < 42 {
            match self.status_filter {
                StatusFilter::All => "ALL",
                StatusFilter::Running => "RUN",
                StatusFilter::NeedsYou => "NEEDS",
                StatusFilter::Archived => "ARCH",
            }
        } else {
            self.status_filter.label()
        };
        let machine_limit = usize::from(inner.width).saturating_sub(filter.len() + 3);
        let machine = clip_label(&machine, machine_limit);
        let connection = if self.selected_host_is_offline() {
            format!("OFFLINE · {} CONNECTED", self.live_hosts.len())
        } else {
            let machine_word = if self.live_hosts.len() == 1 {
                "MACHINE"
            } else {
                "MACHINES"
            };
            format!("CONNECTED · {} {machine_word}", self.live_hosts.len())
        };
        frame.render_widget(
            Paragraph::new(vec![
                Line::styled(format!("{filter} · {machine}"), Style::default().fg(MUTED)),
                Line::styled(connection, Style::default().fg(MUTED)),
            ]),
            Rect::new(inner.x, inner.y, inner.width, 2),
        );
        self.status_filter_hitbox = Some(Rect::new(inner.x, inner.y, inner.width, 1));
        let mut lines = Vec::new();
        let rows = self.rows();
        let has_content = rows
            .iter()
            .any(|row| matches!(row.kind, RowKind::Mission(_) | RowKind::ArchivedAgent(_)));
        if !has_content {
            let empty = match self.status_filter {
                StatusFilter::All => "No missions yet",
                StatusFilter::Running => "No running missions",
                StatusFilter::NeedsYou => "No missions need you",
                StatusFilter::Archived => "No archived conversations",
            };
            lines.push(Line::styled(empty, Style::default().fg(MUTED)));
            if self.status_filter != StatusFilter::All {
                lines.push(Line::styled(
                    "Press s to cycle statuses",
                    Style::default().fg(AMBER),
                ));
            }
            lines.push(Line::styled(
                "Open project  Ctrl+K",
                Style::default().fg(AMBER),
            ));
        }
        // Hitboxes are rebuilt from the same two-line row layout rendered below.
        // This keeps mouse selection correct after expansion and filtering.
        let content_offset: usize = rows
            .iter()
            .take(self.cursor)
            .map(|row| 2 + usize::from(row.date.is_some()))
            .sum();
        let viewport = usize::from(inner.height.saturating_sub(2));
        self.sidebar_scroll = content_offset.saturating_sub(viewport.saturating_sub(2));
        let content_area = Rect::new(
            inner.x,
            inner.y.saturating_add(2),
            inner.width,
            inner.height.saturating_sub(2),
        );
        let content_top = usize::from(content_area.y);
        let content_bottom = content_top.saturating_add(usize::from(content_area.height));
        let mut y = 0usize;
        self.row_hitboxes.clear();
        for (index, row) in rows.iter().enumerate() {
            if let Some(date) = &row.date {
                lines.push(Line::styled(
                    format!("── {date} UTC ──"),
                    Style::default().fg(MUTED),
                ));
                y = y.saturating_add(1);
            }
            let visible_logical_bottom = y
                .saturating_add(2)
                .min(self.sidebar_scroll.saturating_add(viewport));
            if y >= self.sidebar_scroll && y < self.sidebar_scroll.saturating_add(viewport) {
                let visible_top = content_top.saturating_add(y.saturating_sub(self.sidebar_scroll));
                let visible_bottom = content_top
                    .saturating_add(visible_logical_bottom.saturating_sub(self.sidebar_scroll))
                    .min(content_bottom);
                self.row_hitboxes.push((
                    Rect::new(
                        inner.x,
                        u16::try_from(visible_top).unwrap_or(u16::MAX),
                        inner.width,
                        u16::try_from(visible_bottom - visible_top).unwrap_or(u16::MAX),
                    ),
                    index,
                ));
            }
            let style = if index == self.cursor && self.nav_focused {
                Style::default().fg(AMBER).bg(Color::Rgb(48, 41, 30))
            } else if row.state == "NEEDS YOU" {
                Style::default().fg(AMBER)
            } else {
                Style::default().fg(TEXT)
            };
            lines.push(Line::styled(row.label.clone(), style));
            let suffix = if row.detail.is_empty() {
                row.state.clone()
            } else {
                format!("{} · {}", row.state, row.detail)
            };
            lines.push(Line::styled(
                format!("      │ {suffix}"),
                Style::default().fg(if row.state == "NEEDS YOU" {
                    AMBER
                } else {
                    MUTED
                }),
            ));
            y = y.saturating_add(2);
        }
        self.visible_selectable_rows = self.row_hitboxes.len().max(1);
        frame.render_widget(
            Paragraph::new(lines)
                .scroll((u16::try_from(self.sidebar_scroll).unwrap_or(u16::MAX), 0)),
            content_area,
        );
    }

    fn host_label(&self, host_id: &crate::hosts::HostId) -> String {
        let configured = self
            .hosts
            .iter()
            .find(|host| &host.id == host_id)
            .map(|host| host.label.clone())
            .unwrap_or_else(|| host_id.to_string());
        if &self.selected_host == host_id {
            if let Some(snapshot) = &self.snapshot {
                if snapshot.machine.name != configured {
                    return format!("{} · {configured}", snapshot.machine.name);
                }
            }
        }
        configured
    }

    fn tab_label(&self, target: &Target) -> String {
        let Some(presentation) = self.tab_presentations.get(&target.key) else {
            return format!("{} · UNKNOWN", target.name);
        };
        let label = if presentation.offline {
            match presentation.mission_number {
                Some(number) => format!("{} · #{number} · OFFLINE", presentation.actor),
                None => format!("{} · OFFLINE", presentation.actor),
            }
        } else if let Some(number) = presentation.mission_number {
            format!(
                "{} · #{number} · {}",
                presentation.actor, presentation.state
            )
        } else if presentation.role == "Workspace leader" {
            format!("{} · LEADER", presentation.actor)
        } else {
            format!("{} · {}", presentation.actor, presentation.state)
        };
        let duplicates = self
            .tabs
            .iter()
            .filter(|other| {
                other.key != target.key
                    && self.tab_presentations.get(&other.key).is_some_and(|other| {
                        other.actor == presentation.actor
                            && other.mission_number == presentation.mission_number
                            && other.state == presentation.state
                            && other.offline == presentation.offline
                    })
            })
            .count();
        if duplicates > 0 {
            format!("{label} @{}", self.host_label(&target.key.host_id))
        } else {
            label
        }
    }

    fn tab_label_for_width(&self, target: &Target, width: usize) -> String {
        let Some(presentation) = self.tab_presentations.get(&target.key) else {
            return clip_label(&target.name, width);
        };
        let full = self.tab_label(target);
        if full.chars().count() <= width {
            return full;
        }
        let suffix = if presentation.offline {
            match presentation.mission_number {
                Some(number) => format!("#{number} · OFFLINE"),
                None => "OFFLINE".to_owned(),
            }
        } else if let Some(number) = presentation.mission_number {
            format!("#{number} · {}", presentation.state)
        } else if presentation.role == "Workspace leader" {
            "LEADER".to_owned()
        } else {
            presentation.state.clone()
        };
        let suffix_width = suffix.chars().count();
        if width <= suffix_width {
            return clip_label(&suffix, width);
        }
        let duplicate = self.tabs.iter().any(|other| {
            other.key != target.key
                && self.tab_presentations.get(&other.key).is_some_and(|other| {
                    other.actor == presentation.actor
                        && other.mission_number == presentation.mission_number
                        && other.state == presentation.state
                        && other.offline == presentation.offline
                })
        });
        let host = duplicate.then(|| format!("@{}", self.host_label(&target.key.host_id)));
        let reserved = suffix_width + 3 + host.as_ref().map_or(0, |host| host.chars().count() + 1);
        if let Some(host) = host {
            if width > reserved {
                return format!(
                    "{} {host} · {suffix}",
                    clip_label(&presentation.actor, width - reserved)
                );
            }
        }
        format!(
            "{} · {suffix}",
            clip_label(&presentation.actor, width.saturating_sub(suffix_width + 3))
        )
    }

    fn overflow_tab_label(&self, target: &Target) -> String {
        let workspace = self
            .tab_presentations
            .get(&target.key)
            .map(|presentation| presentation.workspace.as_str())
            .unwrap_or(target.workspace_id.as_str());
        format!(
            "{} @{} / {workspace}",
            self.tab_label(target),
            self.host_label(&target.key.host_id)
        )
    }

    fn pane_title(&self, width: u16) -> String {
        let Some(target) = &self.active_target else {
            return " Workspace / machine / Workspace leader ".into();
        };
        let host = self
            .tab_presentations
            .get(&target.key)
            .map(|presentation| presentation.host.clone())
            .filter(|host| !host.is_empty())
            .unwrap_or_else(|| self.host_label(&target.key.host_id));
        let mut workspace = target.workspace_id.clone();
        let mut mission = "Workspace leader".into();
        let mut actor = format!("{} · {}", target.name, target.role);
        if let Some(presentation) = self.tab_presentations.get(&target.key) {
            workspace = presentation.workspace.clone();
            mission = presentation
                .mission
                .as_ref()
                .map(|mission| match presentation.mission_number {
                    Some(number) => format!("#{number} {mission}"),
                    None => mission.clone(),
                })
                .unwrap_or_else(|| "Workspace leader".into());
            actor = format!(
                "{} · {} · {}",
                presentation.actor,
                presentation.role,
                if presentation.offline {
                    "OFFLINE"
                } else {
                    &presentation.state
                }
            );
        } else if let Some(snapshot) = &self.snapshot {
            if target.key.host_id == self.selected_host {
                workspace = snapshot
                    .workspaces
                    .iter()
                    .find(|workspace| workspace.id == target.workspace_id)
                    .map(|workspace| workspace.name.clone())
                    .unwrap_or(workspace);
                if let Some(agent) = snapshot
                    .agents
                    .iter()
                    .find(|agent| agent.session_id == target.session_id)
                {
                    mission = snapshot
                        .missions
                        .iter()
                        .find(|mission| mission.id == agent.mission_id)
                        .map(|mission| mission.name.clone())
                        .unwrap_or(mission);
                    actor = format!("{} · {}", agent.name, status_label(&agent.state));
                } else if let Some(leader) = snapshot
                    .leaders
                    .iter()
                    .find(|leader| leader.session_id == target.session_id)
                {
                    actor = format!("{} · {}", leader.name, status_label(&leader.state));
                }
            }
        }
        let available = usize::from(width.saturating_sub(4));
        if available < 48 {
            return format!(
                " {} / {} ",
                clip_label(&host, available / 2),
                clip_label(&actor, available.saturating_sub(3 + available / 2))
            );
        }
        let title = format!(" {} / {} / {} / {} ", workspace, host, mission, actor);
        clip_label(&title, available)
    }

    fn render_pane(&mut self, frame: &mut Frame<'_>, area: Rect, pane: &PaneState) {
        let title = self.pane_title(area.width);
        let border = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(if self.nav_focused { RULE } else { AMBER }));
        frame.render_widget(border, area);
        self.tab_hitboxes.clear();
        self.tab_close_hitboxes.clear();
        self.overflow_tab_hitboxes.clear();
        self.overflow_hitbox = None;
        self.hidden_tab_ids.clear();
        let tabs_area = Rect::new(area.x, area.y, area.width, 1);
        let mut x = tabs_area.x + 1;
        let mut ordered_tabs = self.tabs.clone();
        if let Some(active) = &self.active_target {
            if let Some(index) = ordered_tabs.iter().position(|tab| tab.key == active.key) {
                let before_active: usize = ordered_tabs[..=index]
                    .iter()
                    .map(|tab| self.tab_label(tab).chars().count() + 4)
                    .sum();
                if before_active > usize::from(tabs_area.width.saturating_sub(5)) {
                    ordered_tabs.rotate_left(index);
                }
            }
        }
        for (index, tab) in ordered_tabs.iter().enumerate() {
            let remaining = tabs_area
                .width
                .saturating_sub(x - tabs_area.x)
                .saturating_sub(4);
            let width = (self.tab_label(tab).chars().count() + 4).min(usize::from(remaining));
            if width < 8 {
                self.hidden_tab_ids
                    .extend(ordered_tabs[index..].iter().map(|tab| tab.key.clone()));
                break;
            }
            let tab_area = Rect::new(x, tabs_area.y, width as u16, 1);
            let close_area = Rect::new(tab_area.right().saturating_sub(2), tab_area.y, 2, 1);
            let select_area =
                Rect::new(tab_area.x, tab_area.y, tab_area.width.saturating_sub(2), 1);
            self.tab_hitboxes.push((select_area, tab.key.clone()));
            self.tab_close_hitboxes.push((close_area, tab.key.clone()));
            let active = self
                .active_target
                .as_ref()
                .is_some_and(|current| current.key == tab.key);
            let label = format!(
                " {} ",
                self.tab_label_for_width(tab, usize::from(width.saturating_sub(3)))
            );
            frame.render_widget(
                Paragraph::new(label).style(Style::default().fg(if active {
                    AMBER
                } else {
                    MUTED
                })),
                tab_area,
            );
            frame.render_widget(
                Paragraph::new("×").style(Style::default().fg(MUTED)),
                close_area,
            );
            x = x.saturating_add(width as u16);
        }
        if !self.hidden_tab_ids.is_empty() {
            let label = format!(" +{} ", self.hidden_tab_ids.len());
            let width = label
                .len()
                .min(usize::from(tabs_area.right().saturating_sub(x)))
                as u16;
            if width > 0 {
                let overflow = Rect::new(x, tabs_area.y, width, 1);
                self.overflow_hitbox = Some(overflow);
                frame.render_widget(
                    Paragraph::new(label).style(Style::default().fg(AMBER)),
                    overflow,
                );
            }
        }
        let breadcrumb_area = Rect::new(
            area.x.saturating_add(1),
            area.y.saturating_add(1),
            area.width.saturating_sub(2),
            1,
        );
        frame.render_widget(
            Paragraph::new(clip_label(&title, usize::from(breadcrumb_area.width)))
                .style(Style::default().fg(MUTED)),
            breadcrumb_area,
        );
        self.pane_area = Rect::new(
            self.pane_area.x,
            self.pane_area.y.saturating_add(1),
            self.pane_area.width,
            self.pane_area.height.saturating_sub(1),
        );
        PaneWidget::new(pane).render(self.pane_area, frame.buffer_mut());
        if self.tab_overflow_open {
            let hidden: Vec<_> = self
                .tabs
                .iter()
                .filter(|tab| self.hidden_tab_ids.contains(&tab.key))
                .collect();
            self.tab_overflow_cursor = self.tab_overflow_cursor.min(hidden.len().saturating_sub(1));
            let height = u16::try_from(hidden.len())
                .unwrap_or(u16::MAX)
                .min(area.height.saturating_sub(3))
                .min(6);
            let start = self
                .tab_overflow_cursor
                .saturating_sub(usize::from(height).saturating_sub(1));
            let menu = Rect::new(
                area.x.saturating_add(2),
                area.y.saturating_add(1),
                area.width.saturating_sub(4).min(38),
                height.saturating_add(2),
            );
            frame.render_widget(Clear, menu);
            frame.render_widget(
                Block::default()
                    .title(" TABS ")
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(AMBER)),
                menu,
            );
            for (index, tab) in hidden
                .into_iter()
                .skip(start)
                .take(usize::from(height))
                .enumerate()
            {
                let row = Rect::new(
                    menu.x.saturating_add(1),
                    menu.y.saturating_add(1 + index as u16),
                    menu.width.saturating_sub(2),
                    1,
                );
                self.overflow_tab_hitboxes.push((row, tab.key.clone()));
                let selected = start + index == self.tab_overflow_cursor;
                frame.render_widget(
                    Paragraph::new(self.overflow_tab_label(tab))
                        .style(Style::default().fg(if selected { AMBER } else { MUTED })),
                    row,
                );
            }
        }
    }

    fn render_compact_tab_overflow(&mut self, frame: &mut Frame<'_>, area: Rect) {
        self.hidden_tab_ids = self.tabs.iter().map(|tab| tab.key.clone()).collect();
        self.overflow_tab_hitboxes.clear();
        self.tab_overflow_cursor = self
            .tab_overflow_cursor
            .min(self.hidden_tab_ids.len().saturating_sub(1));
        let height = u16::try_from(self.hidden_tab_ids.len())
            .unwrap_or(u16::MAX)
            .min(area.height.saturating_sub(3))
            .min(6);
        let start = self
            .tab_overflow_cursor
            .saturating_sub(usize::from(height).saturating_sub(1));
        let menu = Rect::new(
            area.x.saturating_add(2),
            area.y.saturating_add(1),
            area.width.saturating_sub(4).min(38),
            height.saturating_add(2),
        );
        frame.render_widget(Clear, menu);
        frame.render_widget(
            Block::default()
                .title(" TABS ")
                .borders(Borders::ALL)
                .border_style(Style::default().fg(AMBER)),
            menu,
        );
        for (index, tab) in self
            .tabs
            .iter()
            .skip(start)
            .take(usize::from(height))
            .enumerate()
        {
            let row = Rect::new(
                menu.x.saturating_add(1),
                menu.y.saturating_add(1 + index as u16),
                menu.width.saturating_sub(2),
                1,
            );
            self.overflow_tab_hitboxes.push((row, tab.key.clone()));
            let selected = start + index == self.tab_overflow_cursor;
            frame.render_widget(
                Paragraph::new(self.overflow_tab_label(tab))
                    .style(Style::default().fg(if selected { AMBER } else { MUTED })),
                row,
            );
        }
    }

    fn render_saved_transcript(&self, frame: &mut Frame<'_>, area: Rect) {
        let Some(saved) = &self.saved_transcript else {
            frame.render_widget(
                Paragraph::new("Loading saved transcript · read-only")
                    .block(
                        Block::default()
                            .title(" SAVED OUTPUT ")
                            .borders(Borders::ALL)
                            .border_style(Style::default().fg(AMBER)),
                    )
                    .style(Style::default().bg(BG).fg(MUTED)),
                area,
            );
            return;
        };
        let mut lines = vec![
            Line::styled(
                format!(
                    " ARCHIVED · {} · {}",
                    saved.archive.agent_name, saved.archive.mission_name
                ),
                Style::default().fg(AMBER),
            ),
            Line::styled(
                " Saved transcript · read-only · PageUp loads older history · f starts follow-up · e exports archived session",
                Style::default().fg(MUTED),
            ),
            Line::raw(""),
        ];
        for block in &saved.blocks {
            lines.push(Line::styled(
                format!("{}: {}", block.role, block.text),
                Style::default().fg(if block.kind == "tool" { AMBER } else { TEXT }),
            ));
        }
        if saved.blocks.is_empty() {
            lines.push(Line::styled(
                "No saved transcript blocks",
                Style::default().fg(MUTED),
            ));
        }
        frame.render_widget(
            Paragraph::new(lines)
                .block(
                    Block::default()
                        .title(" SAVED OUTPUT ")
                        .borders(Borders::ALL)
                        .border_style(Style::default().fg(AMBER)),
                )
                .style(Style::default().bg(BG))
                .wrap(Wrap { trim: false })
                .scroll((self.saved_scroll, 0)),
            area,
        );
        if let Some(path) = &self.export_path {
            let popup = centered(70, 35, area);
            frame.render_widget(Clear, popup);
            frame.render_widget(
                Paragraph::new(vec![
                    Line::styled(
                        " Export archived session · Enter saves · Esc cancels",
                        Style::default().fg(AMBER),
                    ),
                    Line::styled(path, Style::default().fg(TEXT)),
                ])
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .border_style(Style::default().fg(AMBER)),
                )
                .style(Style::default().bg(BG)),
                popup,
            );
        } else if let Some(message) = &self.error {
            if message.contains("archived session") || message.contains("archive export") {
                let popup = centered(70, 25, area);
                frame.render_widget(Clear, popup);
                frame.render_widget(
                    Paragraph::new(message.as_str())
                        .block(
                            Block::default()
                                .borders(Borders::ALL)
                                .border_style(Style::default().fg(AMBER)),
                        )
                        .style(Style::default().bg(BG).fg(TEXT)),
                    popup,
                );
            }
        }
        if let Some(preview) = &self.fixed_preview {
            let popup = centered(78, 55, area);
            frame.render_widget(Clear, popup);
            let objective = preview
                .objective
                .as_deref()
                .unwrap_or("Loading original objective…");
            frame.render_widget(
                Paragraph::new(vec![
                    Line::styled(
                        " Start follow-up",
                        Style::default().fg(AMBER).add_modifier(Modifier::BOLD),
                    ),
                    Line::raw(format!(" Source mission: {}", preview.archive.mission_id)),
                    Line::raw(" Original objective:"),
                    Line::styled(objective, Style::default().fg(TEXT)),
                    Line::raw(""),
                    Line::styled(
                        " Enter · Insert draft into leader editor · Esc cancels",
                        Style::default().fg(MUTED),
                    ),
                ])
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .border_style(Style::default().fg(AMBER)),
                ),
                popup,
            );
        }
    }

    fn saved_scroll_limit(&self) -> u16 {
        let width = usize::from(self.pane_area.width.saturating_sub(2)).max(1);
        let height = self.pane_area.height.saturating_sub(2);
        let Some(saved) = &self.saved_transcript else {
            return 0;
        };
        let mut lines = 3usize;
        for block in &saved.blocks {
            let text = format!("{}: {}", block.role, block.text);
            lines += text
                .split('\n')
                .map(|line| line.chars().count().div_ceil(width).max(1))
                .sum::<usize>();
        }
        if saved.blocks.is_empty() {
            lines += 1;
        }
        u16::try_from(lines.saturating_sub(usize::from(height))).unwrap_or(u16::MAX)
    }

    fn render_picker(&self, frame: &mut Frame<'_>) {
        let area = centered(70, 55, frame.area());
        frame.render_widget(Clear, area);
        let mut lines = vec![
            Line::styled(
                if self.host_picker {
                    "Choose a machine · Enter connects"
                } else if self.picker_path_mode {
                    "Type a project path and press Enter"
                } else {
                    "Find a workspace · Enter switches · Ctrl+O opens a project"
                },
                Style::default().fg(MUTED),
            ),
            Line::styled(
                format!("> {}", self.picker_input),
                Style::default().fg(TEXT),
            ),
            Line::raw(""),
        ];
        if self.host_picker {
            if self.add_host_form {
                lines.push(Line::styled(
                    if self.editing_host.is_some() {
                        "Edit SSH machine · absolute remote paths · Tab next · Enter saves"
                    } else {
                        "Add SSH machine · absolute remote paths · Tab next · Enter saves"
                    },
                    Style::default().fg(MUTED),
                ));
                for (index, (label, value)) in [
                    "SSH alias or user@host",
                    "Display name",
                    "Remote NETA dir",
                    "Remote workspace (optional)",
                    "SSH config path (optional)",
                    "Remote launcher executable (optional)",
                ]
                .iter()
                .zip(self.add_host_fields.iter())
                .enumerate()
                {
                    lines.push(Line::styled(
                        format!(
                            "{} {}: {}",
                            if index == self.add_host_field {
                                ">"
                            } else {
                                " "
                            },
                            label,
                            value
                        ),
                        Style::default().fg(if index == self.add_host_field {
                            AMBER
                        } else {
                            TEXT
                        }),
                    ));
                    if self
                        .hosts
                        .get(self.picker_cursor)
                        .is_some_and(|host| host.id != crate::hosts::HostId::local())
                    {
                        lines.push(Line::styled(
                            "e edit · d remove",
                            Style::default().fg(MUTED),
                        ));
                    }
                }
                if let Some(host) = self.remove_confirmation() {
                    let confirmation = centered(58, 25, frame.area());
                    frame.render_widget(Clear, confirmation);
                    frame.render_widget(
				Paragraph::new(format!(
					"Forget {}?\n\nThis removes this saved SSH connection from Neta only. Remote files and the remote Neta service keep running.\n\nEnter forgets · Esc cancels",
					host.label
				))
				.block(Block::default().title(" REMOVE MACHINE ").borders(Borders::ALL).border_style(Style::default().fg(AMBER)))
				.style(Style::default().bg(BG).fg(TEXT)),
				confirmation,
			);
                }
            } else {
                for (index, host) in self.hosts.iter().enumerate() {
                    lines.push(Line::styled(
                        format!(
                            "{} {}",
                            if index == self.picker_cursor {
                                ">"
                            } else {
                                " "
                            },
                            host.label
                        ),
                        Style::default().fg(if index == self.picker_cursor {
                            AMBER
                        } else {
                            TEXT
                        }),
                    ));
                }
                lines.push(Line::styled(
                    format!(
                        "{} + Add SSH machine",
                        if self.picker_cursor == self.hosts.len() {
                            ">"
                        } else {
                            " "
                        }
                    ),
                    Style::default().fg(if self.picker_cursor == self.hosts.len() {
                        AMBER
                    } else {
                        TEXT
                    }),
                ));
            }
        } else if !self.picker_path_mode {
            for (index, workspace) in self.filtered_workspaces().iter().enumerate() {
                lines.push(Line::styled(
                    format!(
                        "{} {}  ·  {}  ·  {}{}",
                        if index == self.picker_cursor {
                            ">"
                        } else {
                            " "
                        },
                        workspace.name,
                        workspace.host_label,
                        if workspace.connected {
                            "CONNECTED"
                        } else {
                            "OFFLINE · CACHED"
                        },
                        if workspace.running == 0 && workspace.needs_you == 0 {
                            "idle".into()
                        } else {
                            format!(
                                "{} running · {} needs you",
                                workspace.running, workspace.needs_you
                            )
                        },
                    ),
                    Style::default().fg(if index == self.picker_cursor {
                        AMBER
                    } else {
                        TEXT
                    }),
                ));
                lines.push(Line::styled(
                    format!("    {}", workspace.path),
                    Style::default().fg(MUTED),
                ));
            }
        }
        if let Some(error) = &self.error {
            lines.push(Line::styled(error.clone(), Style::default().fg(AMBER)));
        }
        frame.render_widget(
            Paragraph::new(lines)
                .block(
                    Block::default()
                        .title(if self.host_picker {
                            " MACHINES "
                        } else {
                            " OPEN PROJECT / WORKSPACES "
                        })
                        .borders(Borders::ALL)
                        .border_style(Style::default().fg(AMBER)),
                )
                .style(Style::default().bg(BG)),
            area,
        );
    }

    fn render_help(&self, frame: &mut Frame<'_>) {
        let area = centered(58, 55, frame.area());
        frame.render_widget(Clear, area);
        let lines = vec![
            "Ctrl+Q  quit and restore terminal",
            "Ctrl+K  open project / workspace picker",
            "Ctrl+Space  move focus between spine and Pi",
            "Ctrl+Space, m  choose or reconnect a machine (navigation focused)",
            "Machine picker: e edit · d forget saved machine · Local is protected",
            "Ctrl+Space, c  enter Pi copy view; Ctrl+Space returns to navigation",
            "Ctrl+Space, Shift+E  export diagnostics from connected machines",
            "↑ ↓     move through missions",
            "s       cycle status filter (navigation focused)",
            "Home End / PgUp PgDn  oldest, newest, and page through history",
            "0       open the workspace leader at Now",
            "Enter   expand mission / focus agent",
            "[ ]     switch open tabs while navigation is focused",
            "x       close the active view; work keeps running",
            "t       show overflowed tabs; tab × closes that view",
            "",
            "Pi ACP commands:",
            "/neta-providers [id]  list or switch provider",
            "/neta-model [id]      list or switch model",
            "/neta-reset           reset and reattach this conversation",
            "/neta-history         load the previous history page",
            "/neta-copy            copy the latest remote agent response",
            "",
            "Pi receives Ctrl+C, arrows, Alt/Ctrl keys, paste, and mouse.",
            "↑↓ PgUp/PgDn scroll · Esc/F1 closes help.",
        ];
        let hint = format!(
            " HELP · {} ",
            if self.help_scroll == 0 {
                "↓ scroll"
            } else {
                "↑↓ scroll"
            }
        );
        frame.render_widget(
            Paragraph::new(lines.join("\n"))
                .wrap(Wrap { trim: false })
                .scroll((self.help_scroll, 0))
                .block(
                    Block::default()
                        .title(hint)
                        .borders(Borders::ALL)
                        .border_style(Style::default().fg(AMBER)),
                )
                .style(Style::default().bg(BG).fg(TEXT)),
            area,
        );
    }

    fn render_diagnostics_export(&self, frame: &mut Frame<'_>) {
        let viewport = frame.area();
        let width = viewport.width.saturating_sub(2).min(76);
        let height = viewport.height.saturating_sub(2).min(14);
        let area = Rect::new(
            viewport.x + viewport.width.saturating_sub(width) / 2,
            viewport.y + viewport.height.saturating_sub(height) / 2,
            width,
            height,
        );
        frame.render_widget(Clear, area);
        let path = self.diagnostics_export_path.as_deref().unwrap_or_default();
        let available = usize::from(width.saturating_sub(6));
        let path = tail_text(path, available);
        frame.render_widget(Paragraph::new(format!("Collects conversations and tool output from connected machines.\nStored authentication files are excluded.\n\nDestination:\n{path}\n\nEnter exports · Esc cancels"))
            .block(Block::default().title(" DIAGNOSTICS EXPORT ").borders(Borders::ALL).border_style(Style::default().fg(AMBER)))
            .style(Style::default().bg(BG).fg(TEXT))
            .wrap(Wrap { trim: false }), area);
    }
}

fn tail_text(value: &str, width: usize) -> String {
    if value.chars().count() <= width {
        return value.into();
    }
    let suffix: String = value
        .chars()
        .rev()
        .take(width.saturating_sub(1))
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("…{suffix}")
}

fn clip_label(label: &str, width: usize) -> String {
    if label.chars().count() <= width {
        return label.into();
    }
    if width <= 1 {
        return "…".chars().take(width).collect();
    }
    let mut clipped: String = label.chars().take(width - 1).collect();
    clipped.push('…');
    clipped
}

fn agent_row(agent: &Agent) -> Row {
    Row {
        label: format!("      └ {} · {}", agent.name, agent.task),
        detail: String::new(),
        state: status_label(&agent.state).into(),
        kind: RowKind::Agent(agent.id.clone()),
        date: None,
    }
}
fn centered(width: u16, height: u16, area: Rect) -> Rect {
    let v = Layout::vertical([
        Constraint::Percentage((100 - height) / 2),
        Constraint::Percentage(height),
        Constraint::Percentage((100 - height) / 2),
    ])
    .split(area);
    Layout::horizontal([
        Constraint::Percentage((100 - width) / 2),
        Constraint::Percentage(width),
        Constraint::Percentage((100 - width) / 2),
    ])
    .split(v[1])[1]
}

#[cfg(test)]
pub fn render_buffer(app: &mut App, pane: &PaneState, area: Rect) -> ratatui::buffer::Buffer {
    let backend = ratatui::backend::TestBackend::new(area.width, area.height);
    let mut terminal = ratatui::Terminal::new(backend).expect("test terminal");
    terminal
        .draw(|frame| app.render(frame, pane))
        .expect("draw");
    terminal.backend().buffer().clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use neta_protocol::Target as ProtocolTarget;

    fn target(session_id: &str, workspace_id: &str) -> Target {
        Target::local(ProtocolTarget {
            session_id: session_id.into(),
            workspace_id: workspace_id.into(),
            name: session_id.into(),
            role: "agent".into(),
            cwd: "/tmp".into(),
            provider: "pi".into(),
            model: "m".into(),
        })
    }
    use neta_protocol::{Agent, Leader, Machine, Mission, MissionLead, Workspace, WorkspaceRoot};

    fn spine_snapshot(missions: Vec<(&str, u64, &str)>) -> Snapshot {
        let agents = missions
            .iter()
            .map(|(id, _, _)| Agent {
                id: format!("agent-{id}"),
                mission_id: (*id).into(),
                session_id: format!("session-{id}"),
                name: format!("Agent {id}"),
                task: format!("task {id}"),
                state: "running".into(),
                provider: "fake".into(),
                model: "test".into(),
            })
            .collect();
        Snapshot {
            machine: Machine {
                name: "local".into(),
            },
            workspaces: vec![Workspace {
                id: "workspace".into(),
                name: "repo".into(),
                roots: vec![WorkspaceRoot {
                    machine_id: None,
                    path: "/repo".into(),
                }],
            }],
            leaders: vec![Leader {
                workspace_id: "workspace".into(),
                session_id: "leader-session".into(),
                name: "Leader".into(),
                state: "idle".into(),
                provider: "fake".into(),
                model: "test".into(),
            }],
            missions: missions
                .into_iter()
                .map(|(id, number, created_at)| Mission {
                    id: id.into(),
                    number,
                    workspace_id: "workspace".into(),
                    name: format!("Mission {id}"),
                    state: "running".into(),
                    attention: None,
                    created_at: created_at.into(),
                    worktree: None,
                    lead: MissionLead::Agent {
                        agent_id: format!("agent-{id}"),
                    },
                    agent_ids: vec![format!("agent-{id}")],
                })
                .collect(),
            agents,
        }
    }

    fn shared_session_snapshot(leader_a: &str, agent_a: &str) -> Snapshot {
        Snapshot {
            machine: Machine {
                name: "local".into(),
            },
            workspaces: vec![
                Workspace {
                    id: "workspace-a".into(),
                    name: "A".into(),
                    roots: vec![WorkspaceRoot {
                        machine_id: None,
                        path: "/a".into(),
                    }],
                },
                Workspace {
                    id: "workspace-b".into(),
                    name: "B".into(),
                    roots: vec![WorkspaceRoot {
                        machine_id: None,
                        path: "/b".into(),
                    }],
                },
            ],
            // Put B first: raw session matching must still choose A for an A tab.
            leaders: vec![
                Leader {
                    workspace_id: "workspace-b".into(),
                    session_id: "shared-leader".into(),
                    name: "Leader B".into(),
                    state: "idle".into(),
                    provider: "fake".into(),
                    model: "test".into(),
                },
                Leader {
                    workspace_id: "workspace-a".into(),
                    session_id: leader_a.into(),
                    name: "Leader A".into(),
                    state: "idle".into(),
                    provider: "fake".into(),
                    model: "test".into(),
                },
            ],
            missions: vec![
                Mission {
                    id: "mission-b".into(),
                    number: 2,
                    workspace_id: "workspace-b".into(),
                    name: "B".into(),
                    state: "running".into(),
                    attention: None,
                    created_at: "2026-09-01T00:00:00Z".into(),
                    worktree: None,
                    lead: MissionLead::Agent {
                        agent_id: "agent-b".into(),
                    },
                    agent_ids: vec!["agent-b".into()],
                },
                Mission {
                    id: "mission-a".into(),
                    number: 1,
                    workspace_id: "workspace-a".into(),
                    name: "A".into(),
                    state: "running".into(),
                    attention: None,
                    created_at: "2026-09-01T00:00:00Z".into(),
                    worktree: None,
                    lead: MissionLead::Agent {
                        agent_id: "agent-a".into(),
                    },
                    agent_ids: vec!["agent-a".into()],
                },
            ],
            agents: vec![
                Agent {
                    id: "agent-b".into(),
                    mission_id: "mission-b".into(),
                    session_id: "shared-agent".into(),
                    name: "Agent B".into(),
                    task: "B".into(),
                    state: "running".into(),
                    provider: "fake".into(),
                    model: "test".into(),
                },
                Agent {
                    id: "agent-a".into(),
                    mission_id: "mission-a".into(),
                    session_id: agent_a.into(),
                    name: "Agent A".into(),
                    task: "A".into(),
                    state: "running".into(),
                    provider: "fake".into(),
                    model: "test".into(),
                },
            ],
        }
    }

    #[test]
    fn rebind_scopes_shared_leader_sessions_to_the_active_workspace_and_host() {
        let local = crate::hosts::HostId::local();
        let remote = crate::hosts::HostId::saved("remote").unwrap();
        let current = shared_session_snapshot("shared-leader", "shared-agent");
        let mut app = App::default();
        app.replace_snapshot_for_host(&local, current.clone());
        app.active_target = Some(Target::local(current.leader_target("workspace-a").unwrap()));

        let mut b_reset = current.clone();
        b_reset.leaders[0].session_id = "leader-b-reset".into();
        app.replace_snapshot_for_host(&local, b_reset);
        assert!(app.take_target().is_none());

        let a_reset = shared_session_snapshot("leader-a-reset", "shared-agent");
        app.replace_snapshot_for_host(&local, a_reset.clone());
        let replacement = app.take_target().unwrap();
        assert_eq!(replacement.workspace_id, "workspace-a");
        assert_eq!(replacement.session_id, "leader-a-reset");

        app.active_target = Some(Target::local(current.leader_target("workspace-a").unwrap()));
        app.replace_snapshot_for_host(&local, current);
        app.replace_snapshot_for_host(&remote, a_reset);
        assert!(app.take_target().is_none());
    }

    #[test]
    fn rebind_scopes_shared_agent_sessions_to_the_active_workspace() {
        let local = crate::hosts::HostId::local();
        let current = shared_session_snapshot("shared-leader", "shared-agent");
        let mut app = App::default();
        app.replace_snapshot_for_host(&local, current.clone());
        app.active_target = Some(Target::local(current.agent_target("agent-a").unwrap()));

        let mut b_reset = current.clone();
        b_reset.agents[0].session_id = "agent-b-reset".into();
        app.replace_snapshot_for_host(&local, b_reset);
        assert!(app.take_target().is_none());

        let a_reset = shared_session_snapshot("shared-leader", "agent-a-reset");
        app.replace_snapshot_for_host(&local, a_reset);
        let replacement = app.take_target().unwrap();
        assert_eq!(replacement.workspace_id, "workspace-a");
        assert_eq!(replacement.session_id, "agent-a-reset");
    }
    #[test]
    fn empty_shell_exposes_open_project_and_shortcuts() {
        let mut app = App::default();
        let pane = PaneState::default();
        let buffer = render_buffer(&mut app, &pane, Rect::new(0, 0, 120, 30));
        let text: String = buffer.content().iter().map(|cell| cell.symbol()).collect();
        assert!(text.contains("Open project"));
        assert!(text.contains("Ctrl+Q quit"));
        assert!(text.contains("Workspace leader"));
    }

    #[test]
    fn archive_export_uses_the_loaded_archive_identity_and_cancel_clears_its_path() {
        let mut app = App::default();
        let archive = ArchivedConversation {
            workspace_id: "workspace".into(),
            agent_id: "agent".into(),
            session_id: "session".into(),
            mission_id: "mission".into(),
            mission_name: "Mission".into(),
            agent_name: "Ada".into(),
            task: "task".into(),
        };
        app.saved_transcript = Some(SavedTranscript {
            archive: archive.clone(),
            blocks: vec![],
            prev_cursor: Some("older".into()),
        });
        app.begin_archive_export("/tmp/session.json".into());
        app.submit_archive_export();
        assert_eq!(app.take_archive_export().unwrap().0.session_id, "session");
        app.begin_archive_export("/tmp/cancel.json".into());
        app.clear_saved_transcript();
        assert!(app.export_path.is_none());
        assert!(app.take_archive_export().is_none());
    }

    #[test]
    fn diagnostics_export_modal_keeps_its_action_and_destination_visible_on_small_terminals() {
        let mut app = App::default();
        app.begin_diagnostics_export("/very/long/path/that/ends/in/session-diagnostics".into());
        let pane = PaneState::default();
        for area in [Rect::new(0, 0, 80, 24), Rect::new(0, 0, 40, 24)] {
            let buffer = render_buffer(&mut app, &pane, area);
            let text: String = buffer.content().iter().map(|cell| cell.symbol()).collect();
            assert!(text.contains("DIAGNOSTICS EXPORT"));
            assert!(text.contains("Destination:"));
            assert!(text.contains("Enter exports"));
            assert!(text.contains("session-diagnostics"));
        }
    }

    #[test]
    fn diagnostics_export_results_are_visible_in_the_footer_without_overflowing_it() {
        let pane = PaneState::default();
        for result in [
            Ok("/tmp/diagnostics".into()),
            Ok("/tmp/diagnostics (partial)".into()),
            Err("remote cleanup timed out while exporting diagnostics".into()),
        ] {
            let mut app = App::default();
            app.diagnostics_exporting = true;
            app.finish_diagnostics_export(result);
            for area in [Rect::new(0, 0, 80, 24), Rect::new(0, 0, 40, 24)] {
                let buffer = render_buffer(&mut app, &pane, area);
                let text: String = buffer.content().iter().map(|cell| cell.symbol()).collect();
                assert!(text.contains("diagnostics"));
                assert!(text.contains("Exported") || text.contains("failed"));
            }
        }
    }

    #[test]
    fn launch_failure_is_visible_in_the_footer() {
        let mut app = App::default();
        app.error = Some("cannot open Pi target Ada: preserved legacy Pi session data".into());
        let buffer = render_buffer(&mut app, &PaneState::default(), Rect::new(0, 0, 120, 30));
        let text: String = buffer.content().iter().map(|cell| cell.symbol()).collect();
        assert!(text.contains("cannot open Pi target Ada"));
    }

    #[test]
    fn pane_breadcrumb_and_tabs_attribute_duplicate_agent_names_to_hosts() {
        let local = crate::hosts::HostId::local();
        let remote = crate::hosts::HostId::saved("remote").unwrap();
        let mut app = App::default();
        app.hosts = vec![
            HostChoice {
                id: local.clone(),
                label: "Local machine".into(),
            },
            HostChoice {
                id: remote.clone(),
                label: "Remote host".into(),
            },
        ];
        let mut snapshot = spine_snapshot(vec![("mission", 1, "2026-09-01T10:00:00Z")]);
        snapshot.machine.name = "studio".into();
        snapshot.workspaces[0].name = "neta".into();
        snapshot.missions[0].name = "Picker repair".into();
        snapshot.agents[0].name = "Ada".into();
        let local_target = Target::new(
            local.clone(),
            ProtocolTarget {
                session_id: "session-mission".into(),
                workspace_id: "workspace".into(),
                name: "Ada".into(),
                role: "agent".into(),
                cwd: "/repo".into(),
                provider: "fake".into(),
                model: "test".into(),
            },
        )
        .unwrap();
        let remote_target = Target::new(
            remote.clone(),
            ProtocolTarget {
                session_id: "session-mission".into(),
                workspace_id: "workspace".into(),
                name: "Ada".into(),
                role: "agent".into(),
                cwd: "/repo".into(),
                provider: "fake".into(),
                model: "test".into(),
            },
        )
        .unwrap();
        app.snapshot = Some(snapshot);
        app.set_live_hosts(HashSet::from([local.clone(), remote.clone()]));
        app.add_tab(local_target);
        let local_snapshot = app.snapshot.clone().unwrap();
        app.sync_tab_presentations(&local, &local_snapshot);
        app.tabs.push(remote_target.clone());
        let mut remote_snapshot = app.snapshot.clone().unwrap();
        remote_snapshot.machine.name = "remote-node".into();
        app.sync_tab_presentations(&remote, &remote_snapshot);
        let pane = PaneState::default();
        let buffer = render_buffer(&mut app, &pane, Rect::new(0, 0, 120, 30));
        let text: String = buffer.content().iter().map(|cell| cell.symbol()).collect();
        assert!(
            text.contains("neta / studio / #1 Picker repair / Ada · Mission lead · RUNNING"),
            "{text}"
        );
        assert!(text.contains("Ada · #1 · RUNNING"));
        assert!(app.tab_label(&remote_target).contains("@Remote host"));

        app.select_tab(&remote_target.key);
        let buffer = render_buffer(&mut app, &pane, Rect::new(0, 0, 40, 20));
        let narrow: String = buffer.content().iter().map(|cell| cell.symbol()).collect();
        assert!(narrow.contains("Ada"));
        assert!(narrow.contains("#1"));
        assert!(narrow.contains("RUNNING"));
    }

    #[test]
    fn tab_presentations_are_host_workspace_scoped_and_recover_from_offline() {
        let host = crate::hosts::HostId::saved("remote").unwrap();
        let mut app = App::default();
        app.hosts = vec![HostChoice {
            id: host.clone(),
            label: "Remote host".into(),
        }];
        app.set_live_hosts(HashSet::from([host.clone()]));
        let mut snapshot = spine_snapshot(vec![("one", 3, "2026-09-01T10:00:00Z")]);
        snapshot.machine.name = "remote-node".into();
        snapshot.agents[0].session_id = "shared".into();
        snapshot.agents[0].name = "Sol".into();
        let target = Target::new(
            host.clone(),
            ProtocolTarget {
                session_id: "shared".into(),
                workspace_id: "workspace".into(),
                name: "Sol".into(),
                role: "agent".into(),
                cwd: "/repo".into(),
                provider: "pi".into(),
                model: "m".into(),
            },
        )
        .unwrap();
        app.add_tab(target.clone());

        let mut wrong_workspace = snapshot.clone();
        wrong_workspace.missions[0].workspace_id = "other-workspace".into();
        app.sync_tab_presentations(&host, &wrong_workspace);
        assert_eq!(app.tab_label(&target), "Sol · UNKNOWN");

        app.sync_tab_presentations(&host, &snapshot);
        assert_eq!(app.tab_label(&target), "Sol · #3 · RUNNING");
        snapshot.agents[0].state = "blocked".into();
        app.sync_tab_presentations(&host, &snapshot);
        assert_eq!(app.tab_label(&target), "Sol · #3 · NEEDS YOU");

        app.mark_tabs_offline(&host);
        assert_eq!(app.tab_label(&target), "Sol · #3 · OFFLINE");
        app.set_live_hosts(HashSet::from([host.clone()]));
        app.sync_tab_presentations(&host, &snapshot);
        assert_eq!(app.tab_label(&target), "Sol · #3 · NEEDS YOU");
        assert!(app
            .overflow_tab_label(&target)
            .contains("@Remote host / repo"));
    }

    #[test]
    fn three_tabs_keep_background_host_state_and_workspace_scoped_sessions_separate() {
        let local = crate::hosts::HostId::local();
        let remote = crate::hosts::HostId::saved("remote").unwrap();
        let mut app = App::default();
        app.hosts = vec![
            HostChoice {
                id: local.clone(),
                label: "Local".into(),
            },
            HostChoice {
                id: remote.clone(),
                label: "Remote".into(),
            },
        ];
        app.set_live_hosts(HashSet::from([local.clone(), remote.clone()]));
        let local_target = target("local-session", "workspace");
        let local_snapshot = spine_snapshot(vec![("local", 1, "2026-09-01T10:00:00Z")]);
        let mut remote_snapshot = spine_snapshot(vec![("one", 3, "2026-09-01T10:00:00Z")]);
        remote_snapshot.machine.name = "remote-node".into();
        remote_snapshot.agents[0].session_id = "shared".into();
        remote_snapshot.agents[0].name = "Sol".into();
        let mut second_workspace = remote_snapshot.workspaces[0].clone();
        second_workspace.id = "other".into();
        second_workspace.name = "other-repo".into();
        remote_snapshot.workspaces.push(second_workspace);
        let mut second_mission = remote_snapshot.missions[0].clone();
        second_mission.id = "two".into();
        second_mission.workspace_id = "other".into();
        second_mission.number = 4;
        second_mission.agent_ids = vec!["agent-two".into()];
        remote_snapshot.missions.push(second_mission);
        let mut second_agent = remote_snapshot.agents[0].clone();
        second_agent.id = "agent-two".into();
        second_agent.mission_id = "two".into();
        second_agent.name = "Terra".into();
        second_agent.state = "waiting".into();
        remote_snapshot.agents.push(second_agent);
        let remote_one = Target::new(
            remote.clone(),
            ProtocolTarget {
                session_id: "shared".into(),
                workspace_id: "workspace".into(),
                name: "Sol".into(),
                role: "agent".into(),
                cwd: "/remote".into(),
                provider: "pi".into(),
                model: "m".into(),
            },
        )
        .unwrap();
        let remote_two = Target::new(
            remote.clone(),
            ProtocolTarget {
                session_id: "shared".into(),
                workspace_id: "other".into(),
                name: "Terra".into(),
                role: "agent".into(),
                cwd: "/remote".into(),
                provider: "pi".into(),
                model: "m".into(),
            },
        )
        .unwrap();
        assert_ne!(remote_one.key, remote_two.key);
        app.add_tab(local_target.clone());
        app.sync_tab_presentations(&local, &local_snapshot);
        app.tabs.push(remote_one.clone());
        app.tabs.push(remote_two.clone());
        app.sync_tab_presentations(&remote, &remote_snapshot);
        assert_eq!(app.tab_label(&remote_one), "Sol · #3 · RUNNING");
        assert_eq!(app.tab_label(&remote_two), "Terra · #4 · RUNNING");
        let local_before = app.tab_label(&local_target);
        remote_snapshot.agents[0].state = "blocked".into();
        app.sync_tab_presentations(&remote, &remote_snapshot);
        assert_eq!(app.tab_label(&remote_one), "Sol · #3 · NEEDS YOU");
        assert_eq!(app.tab_label(&local_target), local_before);
        app.mark_tabs_offline(&remote);
        assert_eq!(app.tab_label(&remote_one), "Sol · #3 · OFFLINE");
        assert_eq!(app.tab_label(&remote_two), "Terra · #4 · OFFLINE");
        app.sync_tab_presentations(&remote, &remote_snapshot);
        assert_eq!(app.tab_label(&remote_one), "Sol · #3 · NEEDS YOU");
        assert_eq!(app.tab_label(&remote_two), "Terra · #4 · RUNNING");
        assert!(app.overflow_tab_label(&remote_one).contains("/ repo"));
        assert!(app.overflow_tab_label(&remote_two).contains("/ other-repo"));
    }

    #[test]
    fn pane_geometry_matches_fresh_outer_terminal_size() {
        assert_eq!(
            App::initial_pane_area(Rect::new(0, 0, 100, 30)),
            Rect::new(28, 5, 71, 22)
        );
        assert_eq!(
            App::initial_pane_area(Rect::new(0, 0, 188, 51)),
            Rect::new(45, 5, 142, 43)
        );
    }

    #[test]
    fn narrow_terminal_switches_between_full_width_navigation_and_pane() {
        let mut app = App::default();
        let pane = PaneState::default();
        let area = Rect::new(0, 0, 40, 24);

        render_buffer(&mut app, &pane, area);
        assert_eq!(app.pane_area, Rect::new(1, 5, 38, 16));
        assert_eq!(app.sidebar_area.width, 0);

        app.nav_focused = true;
        render_buffer(&mut app, &pane, area);
        assert_eq!(app.pane_area.width, 0);
        assert_eq!(app.sidebar_area, Rect::new(0, 3, 40, 19));
        assert!(app.status_filter_at((1, 4)));
        assert!(!app.status_filter_at((1, 5)));
    }

    #[test]
    fn footer_makes_focus_and_blocked_input_explicit_at_wide_and_compact_widths() {
        let pane = PaneState::default();
        let mut app = App::default();
        app.set_live_hosts(HashSet::from([crate::hosts::HostId::local()]));

        let wide = render_buffer(&mut app, &pane, Rect::new(0, 0, 120, 30));
        let wide_text: String = wide.content().iter().map(|cell| cell.symbol()).collect();
        assert!(wide_text.contains("PI FOCUSED · keys go to Pi"));
        assert!(wide_text.contains("Ctrl+Space navigation"));
        assert!(wide_text.contains("Ctrl+Q quit"));

        let compact = render_buffer(&mut app, &pane, Rect::new(0, 0, 40, 24));
        let compact_rows = [22, 23].map(|y| {
            (0..40)
                .map(|x| compact.cell((x, y)).expect("footer cell").symbol())
                .collect::<String>()
        });
        assert_eq!(compact_rows[0].trim(), "PI FOCUSED · keys go to Pi");
        assert_eq!(compact_rows[1].trim(), "Ctrl+Space nav  Ctrl+Q quit");
        let compact_status = |app: &mut App, expected: &str| {
            let buffer = render_buffer(app, &pane, Rect::new(0, 0, 40, 24));
            let row: String = (0..40)
                .map(|x| buffer.cell((x, 22)).expect("status cell").symbol())
                .collect();
            assert_eq!(row.trim(), expected);
        };

        app.nav_focused = true;
        let navigation = render_buffer(&mut app, &pane, Rect::new(0, 0, 40, 24));
        let navigation_text: String = navigation
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        assert!(navigation_text.contains("NAVIGATION · keys navigate"));
        assert!(!navigation_text.contains("PI FOCUSED · keys go to Pi"));

        app.picker = true;
        app.help = true;
        let picker = render_buffer(&mut app, &pane, Rect::new(0, 0, 120, 30));
        let picker_text: String = picker.content().iter().map(|cell| cell.symbol()).collect();
        assert!(picker_text.contains("WORKSPACE PICKER · input is captured"));
        assert!(!picker_text.contains("HELP OPEN · Esc closes help"));
        compact_status(&mut app, "WORKSPACE PICKER · input captured");

        app.host_picker = true;
        let machine_picker = render_buffer(&mut app, &pane, Rect::new(0, 0, 120, 30));
        let machine_picker_text: String = machine_picker
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        assert!(machine_picker_text.contains("MACHINE PICKER · input is captured"));
        compact_status(&mut app, "MACHINE PICKER · input captured");
        app.host_picker = false;
        app.picker_path_mode = true;
        let path_picker = render_buffer(&mut app, &pane, Rect::new(0, 0, 120, 30));
        let path_picker_text: String = path_picker
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        assert!(path_picker_text.contains("PROJECT PATH · input is captured"));
        compact_status(&mut app, "PROJECT PATH · input captured");

        app.picker = false;
        app.picker_path_mode = false;
        let help = render_buffer(&mut app, &pane, Rect::new(0, 0, 120, 30));
        let help_text: String = help.content().iter().map(|cell| cell.symbol()).collect();
        assert!(help_text.contains("HELP OPEN · Esc closes help"));
        compact_status(&mut app, "HELP OPEN · Esc closes help");

        app.help = false;
        app.fixed_preview = Some(FollowupPreview {
            archive: ArchivedConversation {
                workspace_id: "workspace".into(),
                agent_id: "agent".into(),
                session_id: "session".into(),
                mission_id: "mission".into(),
                mission_name: "Mission".into(),
                agent_name: "Ada".into(),
                task: "task".into(),
            },
            host_id: crate::hosts::HostId::local(),
            objective: None,
        });
        let followup = render_buffer(&mut app, &pane, Rect::new(0, 0, 120, 30));
        let followup_text: String = followup
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        assert!(followup_text.contains("FOLLOW-UP PREVIEW · Enter sends · Esc cancels"));
        compact_status(&mut app, "FOLLOW-UP · Enter send · Esc cancel");

        app.fixed_preview = None;
        app.export_path = Some("/tmp/archive.json".into());
        let export = render_buffer(&mut app, &pane, Rect::new(0, 0, 120, 30));
        let export_text: String = export.content().iter().map(|cell| cell.symbol()).collect();
        assert!(export_text.contains("ARCHIVE EXPORT · path input is captured"));
        compact_status(&mut app, "ARCHIVE EXPORT · path input captured");

        app.export_path = None;
        app.tab_overflow_open = true;
        let tab_picker = render_buffer(&mut app, &pane, Rect::new(0, 0, 120, 30));
        let tab_picker_text: String = tab_picker
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        assert!(tab_picker_text.contains("TAB PICKER · ↑↓ select · Enter opens"));
        compact_status(&mut app, "TAB PICKER · ↑↓ select · Enter opens");

        app.tab_overflow_open = false;
        app.archive_loading = true;
        let archive = render_buffer(&mut app, &pane, Rect::new(0, 0, 120, 30));
        let archive_text: String = archive.content().iter().map(|cell| cell.symbol()).collect();
        assert!(archive_text.contains("ARCHIVE READ-ONLY"));
        compact_status(&mut app, "ARCHIVE READ-ONLY · ↑↓ scroll");

        app.archive_loading = false;
        app.nav_focused = false;
        app.selected_host = crate::hosts::HostId::saved("offline").unwrap();
        app.workspace_choices = vec![WorkspaceChoice {
            host_id: app.selected_host.clone(),
            workspace_id: "workspace".into(),
            name: "repo".into(),
            path: "/repo".into(),
            host_label: "offline".into(),
            connected: false,
            running: 0,
            needs_you: 0,
        }];
        let offline = render_buffer(&mut app, &pane, Rect::new(0, 0, 120, 30));
        let offline_text: String = offline.content().iter().map(|cell| cell.symbol()).collect();
        assert!(offline_text.contains("MACHINE OFFLINE · Pi input paused"));
        assert!(!offline_text.contains("PI FOCUSED · keys go to Pi"));
        compact_status(&mut app, "MACHINE OFFLINE · Pi input paused");
    }

    #[test]
    fn copy_view_uses_the_full_terminal_without_neta_chrome() {
        let mut app = App::default();
        let pane = PaneState::default();
        let area = Rect::new(0, 0, 80, 24);
        app.enter_copy_view();
        let buffer = render_buffer(&mut app, &pane, area);
        let text: String = buffer.content().iter().map(|cell| cell.symbol()).collect();
        assert_eq!(app.pane_area, area);
        assert_eq!(app.sidebar_area, Rect::default());
        assert!(!text.contains("workspace"));
        assert!(!text.contains("Ctrl+Q"));
        assert!(!text.contains("local Pi"));
        app.leave_copy_view();
        render_buffer(&mut app, &pane, area);
        assert!(!app.copy_view);
        assert!(app.nav_focused);
        assert!(app.pane_area.width < area.width);
    }

    #[test]
    fn snapshot_insertion_preserves_the_selected_mission_by_identity() {
        let mut app = App::default();
        app.workspace_id = Some("workspace".into());
        app.snapshot = Some(spine_snapshot(vec![
            ("old", 1, "2026-09-01T10:00:00Z"),
            ("current", 2, "2026-09-02T10:00:00Z"),
        ]));
        // NOW is index 0; newest-first places `old` at index 2.
        app.cursor = 2;
        app.replace_snapshot(spine_snapshot(vec![
            ("old", 1, "2026-09-01T10:00:00Z"),
            ("current", 2, "2026-09-02T10:00:00Z"),
            ("new", 3, "2026-09-03T10:00:00Z"),
        ]));
        let rows_after_snapshot = app.rows();
        let mission_ids: Vec<_> = rows_after_snapshot
            .iter()
            .filter_map(|row| match &row.kind {
                RowKind::Mission(id) => Some(id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(mission_ids, vec!["new", "current", "old"]);
        assert_eq!(rows_after_snapshot[1].date.as_deref(), Some("2026-09-03"));
        assert!(
            matches!(rows_after_snapshot[app.cursor].kind, RowKind::Mission(ref id) if id == "old")
        );
    }

    #[test]
    fn status_filter_selects_mixed_spine_states_and_keeps_archives_reachable() {
        let mut app = App::default();
        app.workspace_id = Some("workspace".into());
        app.snapshot = Some(spine_snapshot(vec![
            ("running", 1, "2026-09-03T10:00:00Z"),
            ("blocked", 2, "2026-09-02T10:00:00Z"),
            ("done", 3, "2026-09-01T10:00:00Z"),
        ]));
        if let Some(snapshot) = &mut app.snapshot {
            snapshot
                .missions
                .iter_mut()
                .find(|m| m.id == "blocked")
                .unwrap()
                .state = "blocked".into();
            snapshot
                .missions
                .iter_mut()
                .find(|m| m.id == "done")
                .unwrap()
                .state = "closed".into();
        }
        app.cursor = 2;
        app.cycle_status_filter();
        assert_eq!(app.status_filter, StatusFilter::Running);
        assert!(app.rows().iter().all(
            |row| !matches!(&row.kind, RowKind::Mission(id) if id == "blocked" || id == "done")
        ));
        app.cycle_status_filter();
        assert_eq!(app.status_filter, StatusFilter::NeedsYou);
        assert!(app
            .rows()
            .iter()
            .any(|row| matches!(&row.kind, RowKind::Mission(id) if id == "blocked")));
        assert!(!app
            .rows()
            .iter()
            .any(|row| matches!(&row.kind, RowKind::Mission(id) if id == "running")));
        app.archives.push(ArchivedConversation {
            workspace_id: "workspace".into(),
            agent_id: "archived-agent".into(),
            session_id: "s".into(),
            mission_id: "m".into(),
            mission_name: "mission".into(),
            agent_name: "agent".into(),
            task: "task".into(),
        });
        app.archived_expanded = true;
        app.status_filter = StatusFilter::Running;
        assert!(!app
            .rows()
            .iter()
            .any(|row| matches!(&row.kind, RowKind::ArchivedAgent(_))));
        app.status_filter = StatusFilter::NeedsYou;
        app.cycle_status_filter();
        assert_eq!(app.status_filter, StatusFilter::Archived);
        assert!(app
            .rows()
            .iter()
            .any(|row| matches!(&row.kind, RowKind::ArchivedAgent(id) if id == "archived-agent")));
        assert!(matches!(app.rows()[app.cursor].kind, RowKind::ArchiveGroup));
    }

    #[test]
    fn header_counts_every_attention_state_in_the_selected_workspace() {
        let mut app = App::default();
        app.workspace_id = Some("workspace".into());
        let mut snapshot = spine_snapshot(vec![
            ("running", 1, "2026-09-06T10:00:00Z"),
            ("blocked", 2, "2026-09-05T10:00:00Z"),
            ("failed", 3, "2026-09-04T10:00:00Z"),
            ("ready", 4, "2026-09-03T10:00:00Z"),
            ("merged", 5, "2026-09-02T10:00:00Z"),
            ("closed", 6, "2026-09-01T10:00:00Z"),
        ]);
        for (id, state) in [
            ("blocked", "blocked"),
            ("failed", "failed"),
            ("ready", "readyToClose"),
            ("merged", "mergedNotClosed"),
            ("closed", "closed"),
        ] {
            snapshot
                .missions
                .iter_mut()
                .find(|mission| mission.id == id)
                .expect("fixture mission")
                .state = state.into();
        }
        let mut other_workspace = snapshot.missions[1].clone();
        other_workspace.id = "other-blocked".into();
        other_workspace.workspace_id = "other-workspace".into();
        other_workspace.state = "blocked".into();
        snapshot.missions.push(other_workspace);
        app.snapshot = Some(snapshot);

        let buffer = render_buffer(&mut app, &PaneState::default(), Rect::new(0, 0, 200, 30));
        let text: String = buffer.content().iter().map(|cell| cell.symbol()).collect();
        assert!(text.contains("1 running · 4 needs you"), "{text}");
    }

    #[test]
    fn activating_a_mission_with_a_target_focuses_its_pane() {
        let mut app = App::default();
        app.workspace_id = Some("workspace".into());
        app.snapshot = Some(spine_snapshot(vec![("mission", 1, "2026-09-01T10:00:00Z")]));
        app.nav_focused = true;
        app.cursor = 1;
        app.activate();
        assert!(app.take_target().is_some());
        assert!(!app.nav_focused);
    }

    #[test]
    fn selecting_the_leader_with_zero_focuses_its_pane() {
        let mut app = App::default();
        app.workspace_id = Some("workspace".into());
        app.snapshot = Some(spine_snapshot(vec![]));
        app.nav_focused = true;
        app.select_leader();
        assert!(app.take_target().is_some());
        assert!(!app.nav_focused);
    }

    #[test]
    fn long_spine_uses_visible_rows_for_paging_and_only_hits_rendered_rows() {
        let missions = (0..24)
            .map(|number| {
                let day = (number % 9) + 1;
                (
                    format!("mission-{number}"),
                    number as u64 + 1,
                    format!("2026-09-{day:02}T10:00:00Z"),
                )
            })
            .collect::<Vec<_>>();
        let mut app = App::default();
        app.workspace_id = Some("workspace".into());
        app.snapshot = Some(spine_snapshot(
            missions
                .iter()
                .map(|(id, number, date)| (id.as_str(), *number, date.as_str()))
                .collect(),
        ));
        app.cursor = app.rows_len() - 1;
        let pane = PaneState::default();
        let buffer = render_buffer(&mut app, &pane, Rect::new(0, 0, 80, 14));
        assert!(app.sidebar_scroll > 0);
        assert!(app
            .row_at((app.sidebar_area.x + 1, app.sidebar_area.y + 1))
            .is_none());
        let rows = app.rows();
        for (area, index) in &app.row_hitboxes {
            let rendered = buffer
                .cell((area.x, area.y))
                .expect("rendered cell")
                .symbol();
            let expected = rows[*index]
                .label
                .chars()
                .next()
                .expect("row label")
                .to_string();
            assert_eq!(
                rendered, expected,
                "hitbox {index} must start on its rendered row"
            );
        }
        let visible = app.visible_selectable_rows;
        app.move_cursor_home();
        app.move_cursor_page(1);
        assert_eq!(app.cursor, visible.min(app.rows_len() - 1));
    }

    #[test]
    fn picker_filters_host_scoped_workspaces_and_path_mode_hides_them() {
        let mut app = App::default();
        let local = crate::hosts::HostId::local();
        let remote = crate::hosts::HostId::saved("remote").unwrap();
        app.set_workspace_choices(vec![
            WorkspaceChoice {
                host_id: local,
                workspace_id: "same-id".into(),
                name: "neta".into(),
                path: "/one".into(),
                host_label: "mac-mini".into(),
                connected: true,
                running: 1,
                needs_you: 0,
            },
            WorkspaceChoice {
                host_id: remote.clone(),
                workspace_id: "same-id".into(),
                name: "neta".into(),
                path: "/two".into(),
                host_label: "macbook".into(),
                connected: false,
                running: 0,
                needs_you: 1,
            },
        ]);
        app.picker_input = "macbook".into();
        assert_eq!(app.filtered_workspaces().len(), 1);
        app.select_workspace_choice();
        let selected = app.take_workspace_choice().unwrap();
        assert_eq!(selected.host_id, remote);
        assert_eq!(selected.workspace_id, "same-id");
        assert_eq!(selected.path, "/two");
        app.picker = true;
        app.picker_input.clear();
        let pane = PaneState::default();
        let buffer = render_buffer(&mut app, &pane, Rect::new(0, 0, 120, 30));
        let text: String = buffer.content().iter().map(|cell| cell.symbol()).collect();
        assert!(text.contains("macbook"));
        assert!(text.contains("OFFLINE · CACHED"));
        assert!(text.contains("1 needs you"));
        app.picker_path_mode = true;
        assert!(app.filtered_workspaces().is_empty());
        app.select_workspace_choice();
        assert!(app.take_workspace_choice().is_none());
    }

    #[test]
    fn open_completion_only_affects_its_matching_picker_request() {
        let mut app = App {
            picker: true,
            picker_input: "/project".into(),
            ..App::default()
        };
        app.begin_open(4);
        assert!(!app.finish_open(3, None));
        assert!(app.picker);
        assert_eq!(app.pending_open, Some(4));

        assert!(app.finish_open(4, Some("no such directory".into())));
        assert!(app.picker);
        assert_eq!(app.picker_input, "/project");
        assert_eq!(app.pending_open, None);
        assert_eq!(app.error.as_deref(), Some("no such directory"));
    }

    #[test]
    fn archived_agent_opens_saved_transcript_without_a_live_target() {
        let mut app = App::default();
        app.workspace_id = Some("workspace".into());
        app.snapshot = Some(empty_snapshot());
        app.archived_expanded = true;
        app.archives.push(ArchivedConversation {
            workspace_id: "workspace".into(),
            agent_id: "archived-agent".into(),
            session_id: "saved-session".into(),
            mission_id: "mission".into(),
            mission_name: "Past work".into(),
            agent_name: "Ada".into(),
            task: "saved task".into(),
        });
        app.next_archive_request = 1;
        app.active_archive_request = Some(1);
        app.pending_archive = Some(ArchiveRequest {
            id: 1,
            archive: app.archives[0].clone(),
            cursor: None,
        });
        let (request_id, archive, cursor) = app.take_archive_tail().expect("archive tail request");
        assert_eq!(cursor, None);
        app.set_saved_transcript(request_id, archive, Vec::new(), Some("9".into()), false);
        assert!(app.is_read_only_archive());
        assert!(app.take_target().is_none());
        app.request_older_archive();
        assert_eq!(
            app.take_archive_tail().expect("older request").2.as_deref(),
            Some("9")
        );
    }

    #[test]
    fn followup_uses_original_objective_and_routes_a_draft_to_the_workspace_leader() {
        let mut app = App::default();
        app.workspace_id = Some("workspace".into());
        app.snapshot = Some(spine_snapshot(vec![]));
        let archive = ArchivedConversation {
            workspace_id: "workspace".into(),
            agent_id: "archived-agent".into(),
            session_id: "archived-session".into(),
            mission_id: "closed-mission".into(),
            mission_name: "Past work".into(),
            agent_name: "Ada".into(),
            task: "agent task".into(),
        };
        app.saved_transcript = Some(SavedTranscript {
            archive: archive.clone(),
            blocks: vec![],
            prev_cursor: None,
        });
        app.begin_followup_preview();
        let (host, requested) = app
            .take_followup_objective_request()
            .expect("objective request");
        assert_eq!(requested.mission_id, "closed-mission");
        app.set_followup_objective(&host, &archive, "the immutable original objective".into());
        app.submit_followup_preview();
        let target = app.take_target().expect("leader target");
        assert_eq!(target.session_id, "leader-session");
        let draft = app.take_followup_draft().expect("draft");
        assert!(draft.contains("neta_mission"));
        assert!(draft.contains("meaningful name"));
        assert!(draft.contains("`continues` parameter to `closed-mission`"));
        assert!(draft.contains("> the immutable original objective"));
        assert!(draft.contains("Do not resume the archived session."));
        assert!(!draft.contains("agent task"));
    }

    #[test]
    fn cancelling_followup_keeps_the_archived_transcript_open() {
        let mut app = App::default();
        let archive = ArchivedConversation {
            workspace_id: "workspace".into(),
            agent_id: "archived-agent".into(),
            session_id: "archived-session".into(),
            mission_id: "closed-mission".into(),
            mission_name: "Past work".into(),
            agent_name: "Ada".into(),
            task: "agent task".into(),
        };
        app.saved_transcript = Some(SavedTranscript {
            archive,
            blocks: vec![],
            prev_cursor: None,
        });
        app.begin_followup_preview();
        app.cancel_followup_preview();
        assert!(app.saved_transcript.is_some());
        assert!(app.is_read_only_archive());
        assert!(app.take_followup_draft().is_none());
    }

    #[test]
    fn stale_saved_transcript_cannot_replace_a_newer_selection() {
        let mut app = App::default();
        app.workspace_id = Some("workspace".into());
        app.snapshot = Some(empty_snapshot());
        let first = ArchivedConversation {
            workspace_id: "workspace".into(),
            agent_id: "first".into(),
            session_id: "first-session".into(),
            mission_id: "mission".into(),
            mission_name: "Past work".into(),
            agent_name: "Ada".into(),
            task: "first task".into(),
        };
        let second = ArchivedConversation {
            workspace_id: "workspace".into(),
            agent_id: "second".into(),
            session_id: "second-session".into(),
            mission_id: "mission".into(),
            mission_name: "Past work".into(),
            agent_name: "Bea".into(),
            task: "second task".into(),
        };
        app.archives = vec![first.clone(), second.clone()];
        app.archived_expanded = true;
        app.cursor = 2;
        app.activate();
        let (first_request, _, _) = app.take_archive_tail().expect("first request");
        app.cursor = 3;
        app.activate();
        let (second_request, second_archive, _) = app.take_archive_tail().expect("second request");
        app.set_saved_transcript(first_request, first, Vec::new(), None, false);
        assert!(app.saved_transcript.is_none());
        app.set_saved_transcript(second_request, second_archive, Vec::new(), None, false);
        assert_eq!(
            app.saved_transcript
                .as_ref()
                .map(|saved| saved.archive.agent_id.as_str()),
            Some("second")
        );
    }

    fn empty_snapshot() -> Snapshot {
        Snapshot {
            machine: Machine {
                name: "local".into(),
            },
            workspaces: vec![],
            leaders: vec![],
            missions: vec![],
            agents: vec![],
        }
    }

    #[test]
    fn stale_older_page_cannot_append_to_another_archive() {
        let mut app = App::default();
        app.workspace_id = Some("workspace".into());
        let first = ArchivedConversation {
            workspace_id: "workspace".into(),
            agent_id: "first".into(),
            session_id: "first-session".into(),
            mission_id: "mission".into(),
            mission_name: "Past work".into(),
            agent_name: "Ada".into(),
            task: "first task".into(),
        };
        let second = ArchivedConversation {
            workspace_id: "workspace".into(),
            agent_id: "second".into(),
            session_id: "second-session".into(),
            mission_id: "mission".into(),
            mission_name: "Past work".into(),
            agent_name: "Bea".into(),
            task: "second task".into(),
        };
        app.active_archive_request = Some(1);
        app.set_saved_transcript(1, first.clone(), Vec::new(), Some("9".into()), false);
        app.request_older_archive();
        let (older_request, _, _) = app.take_archive_tail().expect("older request");
        app.active_archive_request = Some(3);
        app.set_saved_transcript(3, second.clone(), Vec::new(), None, false);
        app.set_saved_transcript(older_request, first, Vec::new(), None, true);
        assert_eq!(
            app.saved_transcript
                .as_ref()
                .map(|saved| saved.archive.agent_id.as_str()),
            Some("second")
        );
    }

    #[test]
    fn tabs_are_deduplicated_and_selected_by_exact_session_id() {
        let mut app = App::default();
        let target = target("session-a", "workspace-a");
        app.add_tab(target.clone());
        app.add_tab(target.clone());
        assert_eq!(app.tabs.len(), 1);
        app.select_tab(&target.key);
        assert_eq!(app.active_target.as_ref().unwrap().session_id, "session-a");
        assert!(app.tab_at((0, 0)).is_none());
    }

    #[test]
    fn selecting_a_tab_keeps_its_workspace_as_the_spine_view() {
        let mut app = App::default();
        let first = target("session-a", "workspace-a");
        let second = target("session-b", "workspace-b");
        app.add_tab(first.clone());
        app.add_tab(second);
        app.select_tab(&first.key);
        assert_eq!(app.active_target.as_ref().unwrap().session_id, "session-a");
        assert_eq!(app.workspace_id.as_deref(), Some("workspace-a"));
    }

    #[test]
    fn navigation_switches_and_closes_exact_views_without_losing_other_sessions() {
        let mut app = App::default();
        let first = target("session-a", "workspace-a");
        let second = target("session-b", "workspace-b");
        let third = target("session-c", "workspace-c");
        app.add_tab(first.clone());
        app.add_tab(second.clone());
        app.add_tab(third.clone());
        app.select_next_tab(1);
        assert_eq!(
            app.active_target
                .as_ref()
                .map(|target| target.session_id.as_str()),
            Some("session-a")
        );
        app.close_tab(&second.key);
        assert_eq!(
            app.tabs
                .iter()
                .map(|tab| tab.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["session-a", "session-c"]
        );
        assert_eq!(
            app.active_target
                .as_ref()
                .map(|target| target.session_id.as_str()),
            Some("session-a")
        );
        app.close_active_tab();
        assert_eq!(
            app.active_target
                .as_ref()
                .map(|target| target.session_id.as_str()),
            Some("session-c")
        );
        assert_eq!(
            app.pending_target
                .as_ref()
                .map(|target| target.session_id.as_str()),
            Some("session-c")
        );
    }

    #[test]
    fn narrow_tabs_keep_active_visible_and_offer_overflow() {
        let mut app = App::default();
        for number in 0..10 {
            app.add_tab(target(
                &format!("session-{number}"),
                &format!("workspace-{number}"),
            ));
        }
        let active = app.active_target.as_ref().expect("active tab").key.clone();
        let pane = PaneState::default();
        let buffer = render_buffer(&mut app, &pane, Rect::new(0, 0, 80, 18));
        let text: String = buffer.content().iter().map(|cell| cell.symbol()).collect();
        assert!(text.contains("+"));
        assert!(app.tab_hitboxes.iter().any(|(_, id)| id == &active));
        assert!(app.overflow_hitbox.is_some());
        for _ in 0..10 {
            app.select_next_tab(1);
        }
        assert_eq!(
            app.active_target.as_ref().map(|tab| &tab.key),
            Some(&active)
        );
    }

    #[test]
    fn tabs_with_the_same_raw_session_id_are_distinct_across_hosts() {
        let mut app = App::default();
        let local = target("shared-session", "local-workspace");
        let remote = Target::new(
            crate::hosts::HostId::saved("remote").unwrap(),
            ProtocolTarget {
                session_id: "shared-session".into(),
                workspace_id: "remote-workspace".into(),
                name: "remote".into(),
                role: "agent".into(),
                cwd: "/remote".into(),
                provider: "pi".into(),
                model: "m".into(),
            },
        )
        .unwrap();
        app.add_tab(local.clone());
        app.add_tab(remote.clone());

        assert_eq!(app.tabs.len(), 2);
        app.select_tab(&local.key);
        assert_eq!(app.workspace_id.as_deref(), Some("local-workspace"));
        app.select_tab(&remote.key);
        assert_eq!(app.workspace_id.as_deref(), Some("remote-workspace"));
    }

    #[test]
    fn selected_remote_host_scopes_the_leader_target() {
        let remote = crate::hosts::HostId::saved("remote").unwrap();
        let mut app = App::default();
        app.select_host(remote.clone());
        app.workspace_id = Some("workspace".into());
        app.snapshot = Some(spine_snapshot(Vec::new()));

        app.select_leader();

        assert_eq!(
            app.take_target().expect("remote leader").key.host_id,
            remote
        );
    }

    #[test]
    fn machine_header_click_does_not_capture_the_leader_control() {
        let mut app = App::default();
        app.workspace_id = Some("workspace".into());
        app.snapshot = Some(spine_snapshot(Vec::new()));

        assert!(app.host_header_at((12, 0)));
        assert!(!app.host_header_at((24, 0)));
    }

    #[test]
    fn add_machine_form_can_cancel_without_changing_hosts() {
        let mut app = App::default();
        app.set_hosts(vec![HostChoice {
            id: crate::hosts::HostId::local(),
            label: "Local".into(),
        }]);
        app.open_host_picker();
        app.open_add_host();
        app.add_host_fields[0] = "user@host".into();
        app.add_host_form = false;
        assert_eq!(app.hosts.len(), 1);
        assert!(app.take_add_host().is_none());
    }

    #[test]
    fn add_machine_form_keeps_submitted_fields_for_registry_validation() {
        let mut app = App::default();
        app.open_add_host();
        app.add_host_fields = [
            "bad\nhost".into(),
            "Remote".into(),
            "/neta".into(),
            "/repo".into(),
            String::new(),
            String::new(),
        ];
        app.pending_add_host = Some(HostFormSubmission {
            editing: None,
            fields: app.add_host_fields.clone(),
        });
        assert_eq!(app.take_add_host().unwrap().fields[0], "bad\nhost");
        assert_eq!(app.add_host_fields[2], "/neta");
    }

    #[test]
    fn local_machine_has_no_edit_or_remove_action() {
        let mut app = App::default();
        app.set_hosts(vec![HostChoice {
            id: crate::hosts::HostId::local(),
            label: "Local".into(),
        }]);
        app.open_host_picker();
        app.request_edit_selected_host();
        app.request_remove_selected_host();
        assert!(app.take_edit_host().is_none());
        assert!(app.remove_confirmation().is_none());
    }
}
