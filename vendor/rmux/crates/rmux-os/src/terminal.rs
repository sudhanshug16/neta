//! Terminal geometry helpers.

use rmux_types::TerminalSize;

/// Returns the current terminal size, when the platform exposes it.
#[must_use]
pub fn current_size() -> Option<TerminalSize> {
    current_size_impl()
}

/// Enables ANSI/VT escape processing for stdout when the platform requires it.
///
/// Unix terminals generally interpret ANSI directly, so this returns `true`
/// there. On Windows this turns on `ENABLE_VIRTUAL_TERMINAL_PROCESSING` for the
/// current stdout console handle and returns whether ANSI output can be used.
#[must_use]
pub fn enable_virtual_terminal_output() -> bool {
    enable_virtual_terminal_output_impl()
}

#[cfg(unix)]
fn current_size_impl() -> Option<TerminalSize> {
    terminal_size_from_fd(&std::io::stdin()).or_else(|| terminal_size_from_fd(&std::io::stdout()))
}

#[cfg(unix)]
fn enable_virtual_terminal_output_impl() -> bool {
    true
}

#[cfg(unix)]
fn terminal_size_from_fd<Fd>(fd: &Fd) -> Option<TerminalSize>
where
    Fd: std::os::fd::AsRawFd,
{
    let mut winsize = libc::winsize {
        ws_row: 0,
        ws_col: 0,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let result = unsafe {
        // SAFETY: `fd` is borrowed only for this ioctl call, and `winsize`
        // points to writable stack storage with the layout expected by TIOCGWINSZ.
        libc::ioctl(fd.as_raw_fd(), libc::TIOCGWINSZ, &mut winsize)
    };
    if result != 0 {
        return None;
    }
    let size = TerminalSize {
        cols: winsize.ws_col,
        rows: winsize.ws_row,
    };
    (size.cols > 0 && size.rows > 0).then_some(size)
}

#[cfg(windows)]
fn current_size_impl() -> Option<TerminalSize> {
    use windows_sys::Win32::System::Console::{STD_ERROR_HANDLE, STD_OUTPUT_HANDLE};

    terminal_size_from_std_handle(STD_OUTPUT_HANDLE)
        .or_else(|| terminal_size_from_std_handle(STD_ERROR_HANDLE))
}

#[cfg(windows)]
fn enable_virtual_terminal_output_impl() -> bool {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Console::{
        GetConsoleMode, GetStdHandle, SetConsoleMode, ENABLE_VIRTUAL_TERMINAL_PROCESSING,
        STD_OUTPUT_HANDLE,
    };

    let handle = unsafe {
        // SAFETY: GetStdHandle accepts the documented STD_* constants.
        GetStdHandle(STD_OUTPUT_HANDLE)
    };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return false;
    }

    let mut mode = 0;
    let ok = unsafe {
        // SAFETY: `mode` points to writable stack storage for the stdout handle mode.
        GetConsoleMode(handle, &mut mode)
    };
    if ok == 0 {
        return false;
    }

    if mode & ENABLE_VIRTUAL_TERMINAL_PROCESSING != 0 {
        return true;
    }

    let ok = unsafe {
        // SAFETY: `handle` is a console output handle and the mode only adds the
        // documented virtual terminal processing bit.
        SetConsoleMode(handle, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING)
    };
    ok != 0
}

#[cfg(windows)]
fn terminal_size_from_std_handle(handle_id: u32) -> Option<TerminalSize> {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Console::{
        GetConsoleScreenBufferInfo, GetStdHandle, CONSOLE_SCREEN_BUFFER_INFO,
    };

    let handle = unsafe {
        // SAFETY: GetStdHandle accepts the documented STD_* constants.
        GetStdHandle(handle_id)
    };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return None;
    }

    let mut info = std::mem::MaybeUninit::<CONSOLE_SCREEN_BUFFER_INFO>::zeroed();
    let ok = unsafe {
        // SAFETY: `info` is writable for the structure expected by Win32.
        GetConsoleScreenBufferInfo(handle, info.as_mut_ptr())
    };
    if ok == 0 {
        return None;
    }
    let info = unsafe {
        // SAFETY: Win32 reported that it initialized the structure.
        info.assume_init()
    };
    let width = info.srWindow.Right - info.srWindow.Left + 1;
    let height = info.srWindow.Bottom - info.srWindow.Top + 1;
    let cols = u16::try_from(width).ok()?;
    let rows = u16::try_from(height).ok()?;
    (cols > 0 && rows > 0).then_some(TerminalSize { cols, rows })
}
