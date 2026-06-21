/**
 * Central command registry.
 * Each command module calls register() to add itself.
 */
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
