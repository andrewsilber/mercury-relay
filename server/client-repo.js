// CLIENT_REPO: the repo agents clone (used in seed sentences). Default: the official repo. Shown without scheme/.git, e.g. github.com/you/fork.
module.exports = String(process.env.CLIENT_REPO || 'github.com/greybeardconsortium/agentrelay-relay').trim().replace(/^https?:\/\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
