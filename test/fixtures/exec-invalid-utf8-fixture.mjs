const size = Number(process.argv[2] ?? 12000);
process.stdout.write(Buffer.alloc(size, 0xff));
