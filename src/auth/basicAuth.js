import auth from 'basic-auth';

export function basicAuth(user, pass) {
  return (req, res, next) => {
    if (!user || !pass) return next(); // disabled
    const creds = auth(req);
    if (!creds || creds.name !== user || creds.pass !== pass) {
      res.set('WWW-Authenticate', 'Basic realm="Restricted"');
      return res.status(401).send('Authentication required.');
    }
    next();
  };
}
