//! The client-scoped format bindings tmux installs before expanding a
//! client-scoped template.
//!
//! tmux builds one format tree per client through `format_defaults()` and then
//! expands `list-clients`' format, `set-titles-string`, and the rest against
//! it, so `#{client_width}` means the same thing everywhere. Producing them in
//! one place is what keeps those surfaces agreeing: a title expanded against a
//! session-only context silently resolved every `#{client_*}` to the empty
//! string (issue #182).

use crate::format_runtime::RuntimeFormatContext;

/// One attached or control client's `#{client_*}` values, already stringified.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ClientFormatBindings {
    pub(crate) name: String,
    pub(crate) pid: String,
    pub(crate) tty: String,
    pub(crate) activity: String,
    pub(crate) session: String,
    pub(crate) width: String,
    pub(crate) height: String,
    pub(crate) termfeatures: String,
    pub(crate) termname: String,
    pub(crate) termtype: String,
    pub(crate) key_table: String,
    pub(crate) prefix: String,
    pub(crate) uid: String,
    pub(crate) user: String,
    pub(crate) utf8: String,
    pub(crate) control_mode: String,
    pub(crate) flags: String,
}

impl ClientFormatBindings {
    /// Installs these values on a format runtime, overriding any session-scoped
    /// stand-in already bound under the same names.
    pub(crate) fn apply<'a>(&self, runtime: RuntimeFormatContext<'a>) -> RuntimeFormatContext<'a> {
        runtime
            .with_named_value("client_name", self.name.clone())
            .with_named_value("client_pid", self.pid.clone())
            .with_named_value("client_tty", self.tty.clone())
            .with_named_value("client_activity", self.activity.clone())
            .with_named_value("client_session", self.session.clone())
            .with_named_value("client_width", self.width.clone())
            .with_named_value("client_height", self.height.clone())
            .with_named_value("client_termfeatures", self.termfeatures.clone())
            .with_named_value("client_termname", self.termname.clone())
            .with_named_value("client_termtype", self.termtype.clone())
            .with_named_value("client_key_table", self.key_table.clone())
            .with_named_value("client_prefix", self.prefix.clone())
            .with_named_value("client_uid", self.uid.clone())
            .with_named_value("client_user", self.user.clone())
            .with_named_value("client_utf8", self.utf8.clone())
            .with_named_value("client_control_mode", self.control_mode.clone())
            .with_named_value("client_flags", self.flags.clone())
    }
}
