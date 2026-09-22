#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    rmux_server::fuzzing::websocket_client_frame(data);
});
