'use strict';
/** Minimal pure-JS ZIP writer (store + deflate), no native/system `zip` dependency. */
const zlib = require('zlib');
const crypto = require('crypto');

const CRC_TABLE = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const dosTime = () => { const d = new Date(); return { time: u16(((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff), date: u16((((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff) }; }

class ZipBuilder {
  constructor() { this.files = []; }
  /** @param name forward-slash path inside the zip. @param data string or Buffer. */
  add(name, data) {
    if (!name || name.includes('\0') || name.startsWith('/') || name.split('/').some((s) => s === '..')) throw new Error('Unsafe zip entry name: ' + name);
    this.files.push({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8') });
    return this;
  }
  toBuffer() {
    const { time, date } = dosTime();
    const locals = [], central = [];
    let offset = 0;
    for (const f of this.files) {
      const nameBuf = Buffer.from(f.name, 'utf8');
      const comp = zlib.deflateRawSync(f.data, { level: 9 });
      const useComp = comp.length < f.data.length;
      const payload = useComp ? comp : f.data;
      const method = useComp ? 8 : 0;
      const crc = crc32(f.data);
      const local = Buffer.concat([u32(0x04034b50), u16(20), u16(1 << 11), u16(method), time, date, u32(crc), u32(payload.length), u32(f.data.length), u16(nameBuf.length), u16(0), nameBuf]);
      locals.push(local, payload);
      central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(1 << 11), u16(method), time, date, u32(crc), u32(payload.length), u32(f.data.length), u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBuf]));
      offset += local.length + payload.length;
    }
    const cd = Buffer.concat(central);
    const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(this.files.length), u16(this.files.length), u32(cd.length), u32(offset), u16(0)]);
    return Buffer.concat([...locals, cd, eocd]);
  }
}

module.exports = { ZipBuilder, crc32 };
