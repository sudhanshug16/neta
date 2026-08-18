const size = Number(process.argv[2] ?? 12000);
const head = Buffer.from("HEAD_SENTINEL\n", "utf-8");
const tail = Buffer.from("\nTAIL_SENTINEL\n", "utf-8");
const fillerSize = Math.max(0, size - head.length - tail.length);
const filler = Buffer.alloc(fillerSize, 0xff);
process.stdout.write(Buffer.concat([head, filler, tail]));
