module.exports = {
  apps: [{
    name: 'claude-code-ui',
    script: 'server/cli.js',
    cwd: 'E:/Heyang5/claudecodeui',
    env: {
      NODE_ENV: 'production',
      ANTHROPIC_AUTH_TOKEN: 'sk-13196c21af9fb1940e9f0169a84062f7fe6db42c3c8ab2d89752fab775b7c4d6',
      ANTHROPIC_BASE_URL: 'https://rucodes.cc',
      ANTHROPIC_API_KEY: 'sk-13196c21af9fb1940e9f0169a84062f7fe6db42c3c8ab2d89752fab775b7c4d6',
      PORT: 3001,
      HOST: '0.0.0.0',
      CONTEXT_WINDOW: 160000
    }
  }]
};
