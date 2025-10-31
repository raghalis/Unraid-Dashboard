import wol from 'wake_on_lan';
import dgram from 'dgram';
import os from 'os';

export function sendWol(mac, broadcast = '255.255.255.255', iface = 'eth0') {
  return new Promise((resolve, reject) => {
    const packet = wol.createMagicPacket(mac);
    const sock = dgram.createSocket('udp4');

    try {
      // try to bind to the interface's IP (optional)
      const ifAddrs = Object.values(os.networkInterfaces())
        .flat()
        .filter(Boolean)
        .filter(a => a.family === 'IPv4' && !a.internal);
      const match = ifAddrs.find(a => (a?.mac || '').toLowerCase() === mac.toLowerCase());
      sock.bind(0, match?.address || undefined, () => {
        sock.setBroadcast(true);
        sock.send(packet, 0, packet.length, 9, broadcast, (err) => {
          sock.close();
          if (err) reject(err); else resolve();
        });
      });
    } catch (e) {
      try { sock.close(); } catch {}
      reject(e);
    }
  });
}
