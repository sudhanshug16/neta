use rmux_proto::SessionName;

/// Authoritative attachment state for one control-mode transport.
///
/// The session name is the attachment identity, so the state cannot report an
/// attached client without also identifying the attached session.
#[derive(Debug)]
pub(super) struct ControlSessionAttachment {
    session_name: Option<SessionName>,
}

impl ControlSessionAttachment {
    pub(super) fn new(session_name: Option<SessionName>) -> Self {
        Self { session_name }
    }

    pub(super) fn is_attached(&self) -> bool {
        self.session_name.is_some()
    }

    pub(super) fn session_name(&self) -> Option<&SessionName> {
        self.session_name.as_ref()
    }

    pub(super) fn session_name_mut(&mut self) -> &mut Option<SessionName> {
        &mut self.session_name
    }
}
