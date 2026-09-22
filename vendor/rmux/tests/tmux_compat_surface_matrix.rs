#![cfg(unix)]

mod common;

#[path = "tmux_compat_surface_matrix/attached_modes.rs"]
mod attached_modes;
#[path = "tmux_compat_surface_matrix/client_control.rs"]
mod client_control;
#[path = "tmux_compat_surface_matrix/command_surface.rs"]
mod command_surface;
#[path = "tmux_compat_surface_matrix/config_surface.rs"]
mod config_surface;
#[path = "tmux_compat_surface_matrix/control_geometry.rs"]
mod control_geometry;
#[path = "tmux_compat_surface_matrix/list_clients_session_id.rs"]
mod list_clients_session_id;
#[path = "tmux_compat_surface_matrix/read_only_detach.rs"]
mod read_only_detach;
#[path = "tmux_compat_surface_matrix/support.rs"]
mod support;
#[path = "tmux_compat_surface_matrix/window_commands.rs"]
mod window_commands;
