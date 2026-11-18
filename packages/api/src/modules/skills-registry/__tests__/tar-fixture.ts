import { gzipSync } from "node:zlib";

/** A minimal ustar .tar.gz, the shape GitHub's codeload serves ("<repo>-<ref>/…"). */
export function makeTarGz(files: Array<{ path: string; content: string | Buffer; type?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const f of files) {
    const data = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, "utf8");
    const h = Buffer.alloc(512, 0);
    h.write(f.path.slice(0, 100), 0, "utf8");
    h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write(f.type ?? "0", 156);
    h.write("ustar\0", 257); h.write("00", 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

export const SKILL_MD = "---\nname: weekly-report\ndescription: Writes the weekly status report from the company notes.\n---\n\n# Weekly report\n\nRead notes/*.md and summarise the week in five bullets.\n";
