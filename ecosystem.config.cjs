// PM2 Ecosystem Configuration
// https://pm2.keymetrics.io/docs/usage/application-declaration/

module.exports = {
  apps: [
    {
      name: 'polymarket-scanner',
      script: 'dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      error_file: '/var/log/pm2/scanner-error.log',
      out_file: '/var/log/pm2/scanner-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      // Restart Delay bei Crashes
      restart_delay: 5000,
      // Exponential Backoff bei wiederholten Crashes
      exp_backoff_restart_delay: 100,
    },
  ],
};
