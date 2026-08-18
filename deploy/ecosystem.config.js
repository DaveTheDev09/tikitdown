module.exports = {
  apps: [
    {
      name: "tikv2",
      script: "server.js",
      cwd: "/opt/tikv2",
      instances: 1,
      max_memory_restart: "700M",
      env: { NODE_ENV: "production" },
    },
  ],
};