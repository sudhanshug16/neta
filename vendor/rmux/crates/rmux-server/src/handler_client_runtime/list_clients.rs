use rmux_os::identity::UserIdentity;
use rmux_proto::{SessionId, TerminalSize};

use crate::client_flags::ClientFlags;
use crate::client_format::ClientFormatBindings;
use crate::client_names::{attached_client_name, attached_client_tty_path};
use crate::handler::attach_support::ActiveAttach;
use crate::handler::client_runtime_support::{
    attached_client_flags, format_attached_client_flags, format_client_uid, format_client_user,
};
use crate::outer_terminal::OuterTerminalContext;

/// One client whose first attach frame is being rendered before registration.
pub(in crate::handler) struct AttachingClient<'a> {
    pub(in crate::handler) pid: u32,
    pub(in crate::handler) session_name: &'a rmux_proto::SessionName,
    pub(in crate::handler) session_id: SessionId,
    pub(in crate::handler) size: TerminalSize,
    pub(in crate::handler) terminal_context: &'a OuterTerminalContext,
    pub(in crate::handler) flags: ClientFlags,
    pub(in crate::handler) uid: u32,
    pub(in crate::handler) user: UserIdentity,
    pub(in crate::handler) activity_at: i64,
}

#[derive(Debug, Clone)]
pub(in crate::handler) struct ListClientSnapshot {
    pub(in crate::handler) name: String,
    pub(in crate::handler) pid: u32,
    pub(in crate::handler) tty: String,
    pub(in crate::handler) control: bool,
    pub(in crate::handler) session_id: Option<SessionId>,
    pub(in crate::handler) session_name: Option<rmux_proto::SessionName>,
    pub(in crate::handler) order: u64,
    pub(in crate::handler) activity_at: i64,
    pub(in crate::handler) width: u16,
    pub(in crate::handler) height: Option<u16>,
    pub(in crate::handler) sort_height: u16,
    pub(in crate::handler) termname: String,
    pub(in crate::handler) termtype: String,
    pub(in crate::handler) termfeatures: String,
    pub(in crate::handler) utf8: bool,
    pub(in crate::handler) key_table: Option<String>,
    pub(in crate::handler) uid: u32,
    pub(in crate::handler) user: UserIdentity,
    pub(in crate::handler) flags: String,
}

impl ListClientSnapshot {
    pub(in crate::handler) fn key_table_name(&self) -> &str {
        self.key_table.as_deref().unwrap_or("root")
    }

    pub(in crate::handler) fn prefix_value(&self) -> &'static str {
        if self.key_table.as_deref() == Some("prefix") {
            "1"
        } else {
            "0"
        }
    }

    pub(in crate::handler) fn height_value(&self) -> String {
        self.height
            .map(|height| height.to_string())
            .unwrap_or_default()
    }

    pub(in crate::handler) fn terminal_size(&self) -> Option<TerminalSize> {
        Some(TerminalSize {
            cols: self.width,
            rows: self.height?,
        })
    }

    pub(in crate::handler) fn sort_size(&self) -> (u16, u16) {
        (self.width, self.sort_height)
    }

    /// One attached client's record, exactly as `list-clients` reports it.
    ///
    /// The two facts a render resolves rather than stores — the features its
    /// outer terminal really advertises and the key table in effect for it —
    /// are filled in by [`Self::resolved_for_render`], so this can be taken
    /// under the client lock alone.
    pub(in crate::handler) fn from_attached_client(pid: u32, active: &ActiveAttach) -> Self {
        Self {
            name: active.client_name.clone(),
            pid,
            tty: attached_client_tty_path(pid)
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default(),
            control: false,
            session_id: Some(active.session_id),
            session_name: Some(active.session_name.clone()),
            order: active.id,
            activity_at: active.activity_at,
            width: active.client_size.cols,
            height: Some(active.client_size.rows),
            sort_height: active.client_size.rows,
            termname: active.terminal_context.term_name().to_owned(),
            termtype: String::new(),
            termfeatures: String::new(),
            utf8: active.terminal_context.utf8(),
            key_table: active.key_table_name.clone(),
            uid: active.uid,
            user: active.user.clone(),
            flags: format_attached_client_flags(active),
        }
    }

    /// The record of a client that is attaching but is not registered yet.
    ///
    /// Its first frame is rendered before registration, so the title it carries
    /// must already expand against the client's own values rather than wait for
    /// a refresh to correct them (issue #182).
    pub(in crate::handler) fn for_attaching_client(client: AttachingClient<'_>) -> Self {
        Self {
            name: attached_client_name(client.pid),
            pid: client.pid,
            tty: attached_client_tty_path(client.pid)
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default(),
            control: false,
            session_id: Some(client.session_id),
            session_name: Some(client.session_name.clone()),
            order: 0,
            activity_at: client.activity_at,
            width: client.size.cols,
            height: Some(client.size.rows),
            sort_height: client.size.rows,
            termname: client.terminal_context.term_name().to_owned(),
            termtype: String::new(),
            termfeatures: String::new(),
            utf8: client.terminal_context.utf8(),
            key_table: None,
            uid: client.uid,
            user: client.user.clone(),
            flags: attached_client_flags(client.flags, false, client.terminal_context.utf8()),
        }
    }

    /// The same client's record as it reads once a pending `switch-client`
    /// commits.
    ///
    /// A switch renders its frame before it moves the client, so a record taken
    /// from the live registration still names the session being left. That
    /// frame is enqueued only after the commit confirmed this exact
    /// destination, and the linked-family refresh that follows deliberately
    /// excludes the switched client, so a stale `#{client_session}` would
    /// disagree with `#S` and with `list-clients` until an unrelated redraw
    /// happened to correct it (issue #182).
    pub(in crate::handler) fn switched_to_session(
        mut self,
        session_name: &rmux_proto::SessionName,
        session_id: SessionId,
    ) -> Self {
        self.session_name = Some(session_name.clone());
        self.session_id = Some(session_id);
        self
    }

    /// Completes a record with what only a render resolves: the features this
    /// client's outer terminal advertises and its effective key table.
    pub(in crate::handler) fn resolved_for_render(
        mut self,
        termfeatures: String,
        key_table: &str,
    ) -> Self {
        self.termfeatures = termfeatures;
        self.key_table = Some(key_table.to_owned());
        self
    }

    /// The `#{client_*}` bindings tmux installs for this client.
    pub(in crate::handler) fn format_bindings(&self) -> ClientFormatBindings {
        ClientFormatBindings {
            name: self.name.clone(),
            pid: self.pid.to_string(),
            tty: self.tty.clone(),
            activity: self.activity_at.to_string(),
            session: self
                .session_name
                .as_ref()
                .map(ToString::to_string)
                .unwrap_or_default(),
            width: self.width.to_string(),
            height: self.height_value(),
            termfeatures: self.termfeatures.clone(),
            termname: self.termname.clone(),
            termtype: self.termtype.clone(),
            key_table: self.key_table_name().to_owned(),
            prefix: self.prefix_value().to_owned(),
            uid: format_client_uid(self.uid),
            user: format_client_user(self.uid, &self.user),
            utf8: if self.utf8 { "1" } else { "0" }.to_owned(),
            control_mode: if self.control { "1" } else { "0" }.to_owned(),
            flags: self.flags.clone(),
        }
    }
}
