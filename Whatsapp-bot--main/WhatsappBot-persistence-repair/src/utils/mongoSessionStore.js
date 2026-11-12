const session = require('express-session');
const { getDb } = require('../db/mongo');

// Express session store backed by MongoDB so Render restarts/deploys do not
// erase browser login sessions. MongoDB TTL removes expired sessions.
class MongoSessionStore extends session.Store {
  constructor(options = {}) {
    super();
    this.collectionName = options.collectionName || 'web_sessions';
    this.ttlSeconds = options.ttlSeconds || 60 * 60 * 24 * 14;
    this._indexPromise = null;
  }

  async collection() {
    const db = await getDb();
    const collection = db.collection(this.collectionName);
    if (!this._indexPromise) {
      this._indexPromise = collection.createIndex(
        { expiresAt: 1 }, { expireAfterSeconds: 0, name: 'web_sessions_expiry' }
      );
    }
    await this._indexPromise;
    return collection;
  }

  get(sid, callback) {
    this.collection().then(async (c) => {
      const doc = await c.findOne({ _id: sid, expiresAt: { $gt: new Date() } });
      if (!doc) return callback(null, null);
      let data;
      try { data = JSON.parse(doc.session); } catch (_) { await c.deleteOne({ _id: sid }); return callback(null, null); }
      callback(null, data);
    }).catch(callback);
  }

  set(sid, sess, callback = () => {}) {
    this.collection().then((c) => {
      const expiresAt = sess.cookie && sess.cookie.expires
        ? new Date(sess.cookie.expires)
        : new Date(Date.now() + this.ttlSeconds * 1000);
      return c.updateOne(
        { _id: sid },
        { $set: { session: JSON.stringify(sess), expiresAt, updatedAt: new Date() } },
        { upsert: true }
      );
    }).then(() => callback(null)).catch(callback);
  }

  touch(sid, sess, callback = () => {}) {
    this.collection().then((c) => {
      const expiresAt = sess.cookie && sess.cookie.expires
        ? new Date(sess.cookie.expires)
        : new Date(Date.now() + this.ttlSeconds * 1000);
      return c.updateOne({ _id: sid }, { $set: { expiresAt, updatedAt: new Date() } });
    }).then(() => callback(null)).catch(callback);
  }

  destroy(sid, callback = () => {}) {
    this.collection().then((c) => c.deleteOne({ _id: sid }))
      .then(() => callback(null)).catch(callback);
  }
}

module.exports = { MongoSessionStore };
