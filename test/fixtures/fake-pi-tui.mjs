process.stdin.setEncoding("utf8");
process.stdout.write("fake-pi-ready\r\n");
process.on("SIGWINCH", () => process.stdout.write(`size:${process.stdout.columns}x${process.stdout.rows}\r\n`));
process.stdin.on("data", (data) => process.stdout.write(`input:${data}`));
setInterval(() => undefined, 60_000);
