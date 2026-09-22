use std::collections::{HashSet, VecDeque};
use std::io;
use std::time::{Duration, Instant};

use rmux_proto::{
    format_continue_line, format_exit_line, CONTROL_BUFFER_LOW, CONTROL_MAXIMUM_AGE_MS,
};
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::time::timeout;

use super::ControlClientFlags;

const CONTROL_WRITE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug)]
pub(super) struct ControlBlock {
    bytes: Vec<u8>,
    output: bool,
    enqueued_at: Instant,
}

#[derive(Debug, Default)]
pub(super) struct ControlOutputQueue {
    pub(super) blocks: VecDeque<ControlBlock>,
    pub(super) buffered_bytes: usize,
    transport_closed: bool,
}

impl ControlOutputQueue {
    pub(super) fn is_transport_closed(&self) -> bool {
        self.transport_closed
    }

    pub(super) fn enqueue_line(&mut self, bytes: Vec<u8>, output: bool) {
        if self.transport_closed {
            return;
        }
        let bytes = if output {
            bytes
        } else {
            ensure_control_newline(bytes)
        };
        self.buffered_bytes = self.buffered_bytes.saturating_add(bytes.len());
        self.blocks.push_back(ControlBlock {
            bytes,
            output,
            enqueued_at: Instant::now(),
        });
    }

    pub(super) fn enqueue_stdout(&mut self, bytes: Vec<u8>) {
        if bytes.is_empty() {
            return;
        }
        // `enqueue_line` already calls `ensure_control_newline` for non-output blocks.
        self.enqueue_line(bytes, false);
    }
}

pub(super) async fn flush_output_queue(
    output_queue: &mut ControlOutputQueue,
    writer: &mut (impl AsyncWrite + Unpin),
    flags: ControlClientFlags,
    paused_panes: &mut HashSet<u32>,
) -> io::Result<()> {
    if output_queue.transport_closed {
        return Ok(());
    }
    while let Some(block) = output_queue.blocks.front() {
        if block.output
            && !flags.uses_extended_output()
            && block.enqueued_at.elapsed() > Duration::from_millis(CONTROL_MAXIMUM_AGE_MS)
        {
            if let Err(error) =
                write_all_bounded(writer, format_exit_line(Some("too far behind")).as_bytes()).await
            {
                return finish_after_write_error(output_queue, paused_panes, error);
            }
            if let Err(error) = flush_bounded(writer).await {
                return finish_after_write_error(output_queue, paused_panes, error);
            }
            return Err(io::Error::other("too far behind"));
        }

        let block = output_queue
            .blocks
            .pop_front()
            .expect("front block must exist");
        if let Err(error) = write_all_bounded(writer, &block.bytes).await {
            return finish_after_write_error(output_queue, paused_panes, error);
        }
        output_queue.buffered_bytes = output_queue
            .buffered_bytes
            .saturating_sub(block.bytes.len());
        if output_queue.buffered_bytes <= CONTROL_BUFFER_LOW && !paused_panes.is_empty() {
            let pane_ids = paused_panes.drain().collect::<Vec<_>>();
            for pane_id in pane_ids {
                if let Err(error) =
                    write_all_bounded(writer, format_continue_line(pane_id).as_bytes()).await
                {
                    return finish_after_write_error(output_queue, paused_panes, error);
                }
            }
        }
    }
    match flush_bounded(writer).await {
        Ok(()) => Ok(()),
        Err(error) => finish_after_write_error(output_queue, paused_panes, error),
    }
}

fn finish_after_write_error(
    output_queue: &mut ControlOutputQueue,
    paused_panes: &mut HashSet<u32>,
    error: io::Error,
) -> io::Result<()> {
    #[cfg(windows)]
    if matches!(
        error.kind(),
        io::ErrorKind::BrokenPipe
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::NotConnected
            | io::ErrorKind::UnexpectedEof
    ) {
        output_queue.transport_closed = true;
        output_queue.blocks.clear();
        output_queue.buffered_bytes = 0;
        paused_panes.clear();
        return Ok(());
    }

    let _ = (output_queue, paused_panes);
    Err(error)
}

async fn write_all_bounded(writer: &mut (impl AsyncWrite + Unpin), bytes: &[u8]) -> io::Result<()> {
    timeout(CONTROL_WRITE_TIMEOUT, writer.write_all(bytes))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "control client write timed out"))?
}

async fn flush_bounded(writer: &mut (impl AsyncWrite + Unpin)) -> io::Result<()> {
    timeout(CONTROL_WRITE_TIMEOUT, writer.flush())
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "control client flush timed out"))?
}

pub(super) fn ensure_control_newline(mut bytes: Vec<u8>) -> Vec<u8> {
    if !bytes.ends_with(b"\n") {
        bytes.push(b'\n');
    }
    bytes
}
