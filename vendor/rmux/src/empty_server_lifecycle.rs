//! Client-side policy for a daemon created by a sessionless command.

use std::fmt;
use std::path::Path;

use rmux_client::{
    connect_or_absent, wait_for_server_endpoint_cleanup, ClientError, ConnectResult, Connection,
    ServerConnectionProvenance,
};
use rmux_proto::{OptionScopeSelector, Response, RmuxError};

/// Failure while applying the `exit-empty` policy after a startup reply.
#[derive(Debug)]
pub(crate) enum EmptyServerLifecycleError {
    Client(ClientError),
    Command {
        command: &'static str,
        error: RmuxError,
    },
    UnexpectedResponse {
        command: &'static str,
        response: &'static str,
    },
}

impl fmt::Display for EmptyServerLifecycleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Client(error) => fmt::Display::fmt(error, formatter),
            Self::Command { command, error } => write!(formatter, "{command}: {error}"),
            Self::UnexpectedResponse { command, response } => {
                write!(
                    formatter,
                    "protocol error: {command} returned unexpected {response} response"
                )
            }
        }
    }
}

impl std::error::Error for EmptyServerLifecycleError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Client(error) => Some(error),
            Self::Command { error, .. } => Some(error),
            Self::UnexpectedResponse { .. } => None,
        }
    }
}

impl From<ClientError> for EmptyServerLifecycleError {
    fn from(error: ClientError) -> Self {
        Self::Client(error)
    }
}

/// Reconnects to the endpoint created by this invocation and applies the
/// empty-server policy after the whole command queue has delivered its output.
pub(crate) fn shutdown_started_empty_server_at(
    socket_path: &Path,
    provenance: ServerConnectionProvenance,
) -> Result<(), EmptyServerLifecycleError> {
    if provenance != ServerConnectionProvenance::StartedByCaller {
        return Ok(());
    }
    let mut connection = match connect_or_absent(socket_path)? {
        ConnectResult::Connected(connection) => connection,
        ConnectResult::Absent => return Ok(()),
    };
    let result = shutdown_started_empty_server(&mut connection, provenance);
    drop(connection);
    match result {
        Err(EmptyServerLifecycleError::Client(error))
            if server_closed_during_empty_cleanup(&error) =>
        {
            match wait_for_server_endpoint_cleanup(socket_path) {
                Ok(()) => Ok(()),
                Err(_) => Err(EmptyServerLifecycleError::Client(error)),
            }
        }
        result => result,
    }
}

/// Requests shutdown only for the empty daemon created by this invocation and
/// only when its loaded configuration enables `exit-empty`.
pub(crate) fn shutdown_started_empty_server(
    connection: &mut Connection,
    provenance: ServerConnectionProvenance,
) -> Result<(), EmptyServerLifecycleError> {
    if provenance != ServerConnectionProvenance::StartedByCaller {
        return Ok(());
    }

    let response = connection.show_options(
        OptionScopeSelector::ServerGlobal,
        Some("exit-empty".to_owned()),
        true,
        false,
        false,
    )?;
    let exit_empty = match response {
        Response::ShowOptions(response) => option_is_on(response.command_output().stdout()),
        Response::Error(response) => {
            return Err(EmptyServerLifecycleError::Command {
                command: "show-options",
                error: response.error,
            });
        }
        response => {
            return Err(EmptyServerLifecycleError::UnexpectedResponse {
                command: "show-options",
                response: response.command_name(),
            });
        }
    };
    if !exit_empty {
        return Ok(());
    }

    match connection.shutdown_if_idle()? {
        Response::ShutdownIfIdle(_) => Ok(()),
        Response::Error(response) => Err(EmptyServerLifecycleError::Command {
            command: "shutdown-if-idle",
            error: response.error,
        }),
        response => Err(EmptyServerLifecycleError::UnexpectedResponse {
            command: "shutdown-if-idle",
            response: response.command_name(),
        }),
    }
}

fn option_is_on(output: &[u8]) -> bool {
    matches!(output, b"on" | b"on\n" | b"on\r\n")
}

fn server_closed_during_empty_cleanup(error: &ClientError) -> bool {
    matches!(error, ClientError::UnexpectedEof)
        || matches!(
            error,
            ClientError::Io(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::BrokenPipe
                        | std::io::ErrorKind::ConnectionAborted
                        | std::io::ErrorKind::ConnectionReset
                        | std::io::ErrorKind::NotConnected
                        | std::io::ErrorKind::UnexpectedEof
                )
        )
}
