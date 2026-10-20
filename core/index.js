module.exports = { ...require('./relay.js'), createFileStore: require('./store-file.js'), createPgStore: (...a) => require('./store-postgres.js')(...a), createNotifier: require('./notifier.js') };
