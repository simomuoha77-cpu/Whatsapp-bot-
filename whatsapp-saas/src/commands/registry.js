const commands = new Map();

function register(name, definition) {
  commands.set(name.toLowerCase(), definition);
}

function get(name) {
  return commands.get(name.toLowerCase());
}

function getAll() {
  return commands;
}

module.exports = { register, get, getAll };
