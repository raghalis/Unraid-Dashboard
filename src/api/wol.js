import wol from 'wake_on_lan';
import dgram from 'dgram';

export function sendWol(mac, broadcast, iface) {
  return new Promise((resolve, reject) => {
    // wake_on_lan supports broadcast; we can also craft raw packets if needed
    wol.wake(mac, { address: broadcast, interface: iface }, (err) => {
      if (err) return reject(err);
      resolve(true);
    });
  });
}
