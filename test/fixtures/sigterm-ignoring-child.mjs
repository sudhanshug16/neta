process.on("SIGTERM", () => {
	// The parent test fixture exits on SIGTERM; this child proves the process
	// group remains alive until Neta escalates to SIGKILL.
});

process.stdout.write(`ready:${process.pid}\n`);
setInterval(() => {}, 1000);
