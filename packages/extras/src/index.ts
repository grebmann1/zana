module.exports = {
  settings: {
    store: require("./settings/store"),
    skillStore: require("./settings/skill-store"),
  },
  plugins: {
    loader: require("./plugins/loader"),
    scaffold: require("./plugins/scaffold"),
  },
};
