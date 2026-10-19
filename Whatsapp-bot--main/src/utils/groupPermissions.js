function jidNumber(jid) {
  return (jid || '').split('@')[0].split(':')[0];
}

// A group with announce:true has WhatsApp's "Only admins can send messages"
// restriction on. WhatsApp enforces that server-side — there's no code
// workaround. The bot's number must actually be promoted to admin by an
// existing admin in that group; this just detects and surfaces that so the
// dashboard can warn instead of silently failing at post time.
function annotateGroupPermissions(groupsObj, botJid) {
  const botNumber = jidNumber(botJid);
  return Object.values(groupsObj).map((g) => {
    const isBotAdmin = (g.participants || []).some(
      (p) => jidNumber(p.id) === botNumber && (p.admin === 'admin' || p.admin === 'superadmin')
    );
    return {
      id: g.id,
      subject: g.subject,
      announce: !!g.announce,
      isBotAdmin,
      canPost: !g.announce || isBotAdmin,
    };
  });
}

module.exports = { jidNumber, annotateGroupPermissions };
