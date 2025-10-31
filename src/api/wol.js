import wol from 'wake_on_lan';

export function sendWol(mac, broadcast, iface) {
  return new Promise((resolve, reject) => {
    wol.wake(mac, { address: broadcast, interface: iface }, (err) => {
      if (err) return reject(err);
      resolve(true);
    });
  });
}
