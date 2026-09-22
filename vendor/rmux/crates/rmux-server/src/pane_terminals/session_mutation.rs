use std::collections::{BTreeMap, HashMap, HashSet};

use rmux_core::{
    EnvironmentStore, HookStore, OptionStore, PaneId, Session, SessionStore, WindowId,
};
use rmux_proto::{PaneTarget, RmuxError, SessionName, TerminalPixels, TerminalSize, WindowTarget};

use super::{
    session_not_found, AppliedWindowResizeQueue, HandlerState, PaneExitMetadata,
    PaneLifecycleState, WindowLinkGroup, WindowLinkSlot,
};

pub(crate) struct SessionTransferSnapshot {
    sessions: SessionStore,
    options: OptionStore,
    environment: EnvironmentStore,
    hooks: HookStore,
    pane_lifecycle: HashMap<PaneId, PaneLifecycleState>,
    attached_terminal_pixels: HashMap<SessionName, TerminalPixels>,
    dead_panes: HashMap<SessionName, HashMap<PaneId, PaneExitMetadata>>,
    auto_named_windows: HashSet<(SessionName, u32)>,
    window_link_groups: HashMap<u64, WindowLinkGroup>,
    window_link_slots: HashMap<WindowLinkSlot, u64>,
    window_link_occurrences: HashMap<WindowLinkSlot, super::WindowLinkOccurrenceId>,
    next_window_link_group_id: u64,
    next_window_link_occurrence_id: u64,
    applied_window_resizes: AppliedWindowResizeQueue,
}

struct WindowGeometryBefore {
    window_id: WindowId,
    preferred_target: WindowTarget,
    preferred_sessions: Vec<SessionName>,
    size: TerminalSize,
}

struct WindowGeometrySnapshot {
    windows: Vec<WindowGeometryBefore>,
}

#[derive(Debug, Clone)]
pub(super) struct PaneTransferGeometryContext {
    source: WindowTarget,
    target: WindowTarget,
}

impl PaneTransferGeometryContext {
    pub(super) fn new(source: &PaneTarget, target: &PaneTarget) -> Self {
        Self {
            source: WindowTarget::with_window(source.session_name().clone(), source.window_index()),
            target: WindowTarget::with_window(target.session_name().clone(), target.window_index()),
        }
    }

    fn preferred_sessions(
        &self,
        window_id: WindowId,
        source_window_id: Option<WindowId>,
    ) -> Vec<SessionName> {
        let (first, second) = if source_window_id == Some(window_id) {
            (self.source.session_name(), self.target.session_name())
        } else {
            (self.target.session_name(), self.source.session_name())
        };
        let mut sessions = vec![first.clone()];
        if second != first {
            sessions.push(second.clone());
        }
        sessions
    }
}

impl SessionTransferSnapshot {
    pub(crate) fn capture(state: &HandlerState) -> Self {
        Self {
            sessions: state.sessions.clone(),
            options: state.options.clone(),
            environment: state.environment.clone(),
            hooks: state.hooks.clone(),
            pane_lifecycle: state.pane_lifecycle.clone(),
            attached_terminal_pixels: state.attached_terminal_pixels.clone(),
            dead_panes: state.dead_panes.clone(),
            auto_named_windows: state.auto_named_windows.clone(),
            window_link_groups: state.window_link_groups.clone(),
            window_link_slots: state.window_link_slots.clone(),
            window_link_occurrences: state.window_link_occurrences.clone(),
            next_window_link_group_id: state.next_window_link_group_id,
            next_window_link_occurrence_id: state.next_window_link_occurrence_id,
            applied_window_resizes: state.applied_window_resizes.clone(),
        }
    }

    pub(crate) fn restore(self, state: &mut HandlerState) {
        state.sessions = self.sessions;
        state.options = self.options;
        state.environment = self.environment;
        state.hooks = self.hooks;
        state.pane_lifecycle = self.pane_lifecycle;
        state.attached_terminal_pixels = self.attached_terminal_pixels;
        state.dead_panes = self.dead_panes;
        state.auto_named_windows = self.auto_named_windows;
        state.window_link_groups = self.window_link_groups;
        state.window_link_slots = self.window_link_slots;
        state.window_link_occurrences = self.window_link_occurrences;
        state.next_window_link_group_id = self.next_window_link_group_id;
        state.next_window_link_occurrence_id = self.next_window_link_occurrence_id;
        // A rolled-back geometry change owes no notification: restoring the
        // session model must also retract the resizes it undid.
        state.applied_window_resizes = self.applied_window_resizes;
    }
}

impl WindowGeometrySnapshot {
    fn capture_all(state: &HandlerState, context: &PaneTransferGeometryContext) -> Self {
        let source_window_id = window_id_at(state, &context.source);
        let target_window_id = window_id_at(state, &context.target);
        let mut aliases_by_window = BTreeMap::<WindowId, Vec<(WindowTarget, TerminalSize)>>::new();
        for (session_name, session) in state.sessions.iter() {
            for (&window_index, window) in session.windows() {
                aliases_by_window.entry(window.id()).or_default().push((
                    WindowTarget::with_window(session_name.clone(), window_index),
                    window.size(),
                ));
            }
        }

        for aliases in aliases_by_window.values_mut() {
            aliases.sort_by(|(left, _), (right, _)| {
                (left.session_name().as_str(), left.window_index())
                    .cmp(&(right.session_name().as_str(), right.window_index()))
            });
        }

        let mut seen = HashSet::new();
        let mut ordered_window_ids = Vec::with_capacity(aliases_by_window.len());
        for window_id in [source_window_id, target_window_id].into_iter().flatten() {
            if aliases_by_window.contains_key(&window_id) && seen.insert(window_id) {
                ordered_window_ids.push(window_id);
            }
        }
        for &window_id in aliases_by_window.keys() {
            if seen.insert(window_id) {
                ordered_window_ids.push(window_id);
            }
        }

        let windows = ordered_window_ids
            .into_iter()
            .filter_map(|window_id| {
                let aliases = aliases_by_window.remove(&window_id)?;
                let preferred_sessions = context.preferred_sessions(window_id, source_window_id);
                let requested_target = if source_window_id == Some(window_id) {
                    Some(&context.source)
                } else if target_window_id == Some(window_id) {
                    Some(&context.target)
                } else {
                    None
                };
                let (preferred_target, size) =
                    preferred_alias(&aliases, requested_target, &preferred_sessions)?;
                Some(WindowGeometryBefore {
                    window_id,
                    preferred_target,
                    preferred_sessions,
                    size,
                })
            })
            .collect();
        Self { windows }
    }

    fn record_changes(self, state: &mut HandlerState) {
        for before in self.windows {
            let Some((target, size)) = before.resolve_current(state) else {
                continue;
            };
            if size != before.size {
                state.record_applied_window_resize(target);
            }
        }
    }
}

impl WindowGeometryBefore {
    fn resolve_current(&self, state: &HandlerState) -> Option<(WindowTarget, TerminalSize)> {
        if let Some(window) = state
            .sessions
            .session(self.preferred_target.session_name())
            .and_then(|session| session.window_at(self.preferred_target.window_index()))
            .filter(|window| window.id() == self.window_id)
        {
            return Some((self.preferred_target.clone(), window.size()));
        }

        for session_name in &self.preferred_sessions {
            let Some(session) = state.sessions.session(session_name) else {
                continue;
            };
            if let Some((&window_index, window)) = session
                .windows()
                .iter()
                .find(|(_, window)| window.id() == self.window_id)
            {
                return Some((
                    WindowTarget::with_window(session_name.clone(), window_index),
                    window.size(),
                ));
            }
        }

        let mut fallback = None;
        for (session_name, session) in state.sessions.iter() {
            for (&window_index, window) in session.windows() {
                if window.id() != self.window_id {
                    continue;
                }
                let is_better = fallback.as_ref().is_none_or(
                    |(best_session, best_index, _): &(SessionName, u32, TerminalSize)| {
                        (session_name.as_str(), window_index) < (best_session.as_str(), *best_index)
                    },
                );
                if is_better {
                    fallback = Some((session_name.clone(), window_index, window.size()));
                }
            }
        }
        fallback.map(|(session_name, window_index, size)| {
            (WindowTarget::with_window(session_name, window_index), size)
        })
    }
}

fn window_id_at(state: &HandlerState, target: &WindowTarget) -> Option<WindowId> {
    state
        .sessions
        .session(target.session_name())
        .and_then(|session| session.window_at(target.window_index()))
        .map(rmux_core::Window::id)
}

fn preferred_alias(
    aliases: &[(WindowTarget, TerminalSize)],
    requested_target: Option<&WindowTarget>,
    preferred_sessions: &[SessionName],
) -> Option<(WindowTarget, TerminalSize)> {
    if let Some(requested_target) = requested_target {
        if let Some((target, size)) = aliases
            .iter()
            .find(|(target, _)| target == requested_target)
        {
            return Some((target.clone(), *size));
        }
    }
    for session_name in preferred_sessions {
        if let Some((target, size)) = aliases
            .iter()
            .find(|(target, _)| target.session_name() == session_name)
        {
            return Some((target.clone(), *size));
        }
    }
    aliases
        .first()
        .map(|(target, size)| (target.clone(), *size))
}

impl HandlerState {
    /// Runs one join/move mutation, then records every surviving stable
    /// window identity whose content size changed.
    ///
    /// Both public join/move entry points pass through this boundary and the
    /// snapshot covers every existing window, so callers cannot silently omit
    /// a sibling target. The typed context controls deterministic alias and
    /// publication preference only; it never limits snapshot coverage. The
    /// comparison runs after both success and error returns. Transactional
    /// errors restore their model snapshot and compare equal; a partially
    /// committed error still owes the same notification as a successful write.
    pub(super) fn mutate_join_or_move_and_record_window_geometry_changes<T, F>(
        &mut self,
        context: PaneTransferGeometryContext,
        mutate: F,
    ) -> T
    where
        F: FnOnce(&mut Self) -> T,
    {
        let geometry_before = WindowGeometrySnapshot::capture_all(self, &context);
        let result = mutate(self);
        geometry_before.record_changes(self);
        result
    }

    pub(crate) fn mutate_session_and_resize_active_window_geometry<T, F>(
        &mut self,
        session_name: &SessionName,
        mutate: F,
    ) -> Result<T, RmuxError>
    where
        F: FnOnce(&mut Session) -> Result<T, RmuxError>,
    {
        let active_window_index = self
            .sessions
            .session(session_name)
            .ok_or_else(|| session_not_found(session_name))?
            .active_window_index();
        self.mutate_session_and_resize_window_terminal(session_name, active_window_index, mutate)
    }

    pub(crate) fn mutate_session_and_resize_window_terminal<T, F>(
        &mut self,
        session_name: &SessionName,
        window_index: u32,
        mutate: F,
    ) -> Result<T, RmuxError>
    where
        F: FnOnce(&mut Session) -> Result<T, RmuxError>,
    {
        self.mutate_session_and_resize_window_terminal_with_family(
            session_name,
            window_index,
            mutate,
        )
        .map(|(result, _)| result)
    }

    pub(crate) fn mutate_session_and_resize_window_terminal_with_family<T, F>(
        &mut self,
        session_name: &SessionName,
        window_index: u32,
        mutate: F,
    ) -> Result<(T, Vec<SessionName>), RmuxError>
    where
        F: FnOnce(&mut Session) -> Result<T, RmuxError>,
    {
        self.mutate_session_and_resize_window_terminal_with_family_if(
            session_name,
            window_index,
            mutate,
            |_| true,
        )
    }

    /// The primary chokepoint for mutations scoped to one stored window.
    ///
    /// tmux 3.7b keeps the equivalent invariant inside `resize_window()`: a
    /// window whose size actually changed always publishes
    /// `window-layout-changed` and then `window-resized`, and control clients see
    /// the former as `%layout-change`. Publication here is asynchronous, so a
    /// window whose size really moved is recorded on the state and drained by
    /// `RequestHandler::publish_applied_window_resizes`. Join/move transfers use
    /// the mandatory all-window snapshot boundary above to preserve the same
    /// invariant across stable window identities.
    pub(crate) fn mutate_session_and_resize_window_terminal_with_family_if<T, F, P>(
        &mut self,
        session_name: &SessionName,
        window_index: u32,
        mutate: F,
        should_resize: P,
    ) -> Result<(T, Vec<SessionName>), RmuxError>
    where
        F: FnOnce(&mut Session) -> Result<T, RmuxError>,
        P: FnOnce(&T) -> bool,
    {
        let geometry_before = self.window_content_size(session_name, window_index);
        let (result, synchronized_sessions, snapshot) = self
            .mutate_session_and_synchronize_window_family_with_snapshot(
                session_name,
                window_index,
                mutate,
            )?;

        if !should_resize(&result) {
            self.record_window_geometry_change(session_name, window_index, geometry_before);
            return Ok((result, synchronized_sessions));
        }

        if let Err(error) = self.resize_window_terminal_runtime(session_name, window_index) {
            snapshot.restore(self);
            self.resize_window_terminal_runtime(session_name, window_index)
                .map_err(|rollback_error| {
                    RmuxError::Server(format!(
                        "failed to roll back window runtime for {session_name}:{window_index} after {error}: {rollback_error}"
                    ))
                })?;
            return Err(error);
        }

        for synchronized_session in &synchronized_sessions {
            self.sync_pane_lifecycle_dimensions_for_session(synchronized_session);
        }
        self.record_window_geometry_change(session_name, window_index, geometry_before);
        Ok((result, synchronized_sessions))
    }

    fn record_window_geometry_change(
        &mut self,
        session_name: &SessionName,
        window_index: u32,
        geometry_before: Option<rmux_proto::TerminalSize>,
    ) {
        let geometry_after = self.window_content_size(session_name, window_index);
        if geometry_after.is_none() || geometry_after == geometry_before {
            return;
        }
        self.record_applied_window_resize(WindowTarget::with_window(
            session_name.clone(),
            window_index,
        ));
    }

    fn window_content_size(
        &self,
        session_name: &SessionName,
        window_index: u32,
    ) -> Option<rmux_proto::TerminalSize> {
        self.sessions
            .session(session_name)
            .and_then(|session| session.window_at(window_index))
            .map(rmux_core::Window::size)
    }

    pub(crate) fn mutate_session_and_synchronize_window_family<T, F>(
        &mut self,
        session_name: &SessionName,
        window_index: u32,
        mutate: F,
    ) -> Result<(T, Vec<SessionName>), RmuxError>
    where
        F: FnOnce(&mut Session) -> Result<T, RmuxError>,
    {
        self.mutate_session_and_synchronize_window_family_with_snapshot(
            session_name,
            window_index,
            mutate,
        )
        .map(|(result, synchronized_sessions, _)| (result, synchronized_sessions))
    }

    fn mutate_session_and_synchronize_window_family_with_snapshot<T, F>(
        &mut self,
        session_name: &SessionName,
        window_index: u32,
        mutate: F,
    ) -> Result<(T, Vec<SessionName>, SessionTransferSnapshot), RmuxError>
    where
        F: FnOnce(&mut Session) -> Result<T, RmuxError>,
    {
        let snapshot = SessionTransferSnapshot::capture(self);
        let result = {
            let session = self
                .sessions
                .session_mut(session_name)
                .ok_or_else(|| session_not_found(session_name))?;
            mutate(session)
        };
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                snapshot.restore(self);
                return Err(error);
            }
        };
        let synchronized_sessions =
            match self.synchronize_linked_window_family_from_slot(session_name, window_index) {
                Ok(synchronized_sessions) => synchronized_sessions,
                Err(error) => {
                    snapshot.restore(self);
                    return Err(error);
                }
            };
        Ok((result, synchronized_sessions, snapshot))
    }

    #[cfg(test)]
    pub(crate) fn mutate_session_and_resize_terminals<T, F>(
        &mut self,
        session_name: &SessionName,
        mutate: F,
    ) -> Result<T, RmuxError>
    where
        F: FnOnce(&mut Session) -> Result<T, RmuxError>,
    {
        let previous_session = self
            .sessions
            .session(session_name)
            .cloned()
            .ok_or_else(|| session_not_found(session_name))?;
        let result = {
            let session = self
                .sessions
                .session_mut(session_name)
                .ok_or_else(|| session_not_found(session_name))?;
            mutate(session)
        };
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                self.replace_session(session_name, previous_session)?;
                return Err(error);
            }
        };

        if let Err(error) = self.resize_terminals(session_name) {
            self.restore_session_after_resize_error(session_name, previous_session, &error)?;
            return Err(error);
        }

        self.synchronize_session_group_from(session_name)?;
        self.sync_pane_lifecycle_dimensions_for_session(session_name);

        Ok(result)
    }

    pub(crate) fn mutate_session_transfer_and_resize_terminals<T, C, F, M, R, A>(
        &mut self,
        session_name: &SessionName,
        mutate: F,
        move_runtime: M,
        rollback_runtime: R,
        finalize_model: A,
    ) -> Result<(T, C), RmuxError>
    where
        F: FnOnce(&mut Session) -> Result<T, RmuxError>,
        M: FnOnce(&mut Self, &T) -> Result<(), RmuxError>,
        R: FnOnce(&mut Self, &T) -> Result<(), RmuxError>,
        A: FnOnce(&mut Self, &T) -> Result<C, RmuxError>,
    {
        let snapshot = SessionTransferSnapshot::capture(self);
        let result = {
            let session = self
                .sessions
                .session_mut(session_name)
                .ok_or_else(|| session_not_found(session_name))?;
            mutate(session)
        };
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                snapshot.restore(self);
                return Err(error);
            }
        };

        if let Err(error) = move_runtime(self, &result) {
            snapshot.restore(self);
            return Err(error);
        }

        let committed = finalize_model(self, &result)
            .and_then(|committed| self.resize_terminals(session_name).map(|()| committed));
        let committed = match committed {
            Ok(committed) => committed,
            Err(error) => {
                let runtime_rollback = rollback_runtime(self, &result);
                snapshot.restore(self);
                let session_rollback =
                    self.resize_terminals(session_name)
                        .map_err(|rollback_error| {
                            RmuxError::Server(format!(
                        "failed to roll back session {session_name} after {error}: {rollback_error}"
                    ))
                        });
                if let Err(rollback_error) = runtime_rollback {
                    return Err(RmuxError::Server(format!(
                        "failed to roll back pane runtime transfer after {error}: {rollback_error}"
                    )));
                }
                session_rollback?;
                return Err(error);
            }
        };

        Ok((result, committed))
    }
}

#[cfg(test)]
#[path = "session_mutation_tests.rs"]
mod tests;
