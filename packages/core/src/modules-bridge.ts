let modules = {};
module.exports = {
  register(id, api) { modules[id] = api; },
  getModule(id) { return modules[id] || null; },
};
