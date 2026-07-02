import { Hono } from 'hono';
import { loadPerson } from './lib/session.js';
import { requestMeta } from './lib/geo.js';
import { auth } from './routes/auth.js';
import { festivals } from './routes/festivals.js';
import { items } from './routes/items.js';
import { people } from './routes/people.js';
import { rides } from './routes/rides.js';
import { mine } from './routes/mine.js';
import { log } from './routes/log.js';
import { admin } from './routes/admin.js';
import { webring } from './routes/webring.js';

export const app = new Hono();

app.use('*', async (c, next) => {
    c.set('reqMeta', requestMeta(c));
    c.set('person', await loadPerson(c));
    await next();
});

app.route('/', auth);
app.route('/', festivals);
app.route('/', items);
app.route('/', people);
app.route('/', rides);
app.route('/', mine);
app.route('/', log);
app.route('/', admin);
app.route('/', webring);
