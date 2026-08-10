# GitLab CE

Git hosting and CI/CD at `https://gitlab.${DOMAIN}`, with SSH published on `${GITLAB_SSH_PORT:-2222}`.

Copy `.env.example` to `.env`, set a strong `GITLAB_ROOT_PASSWORD`, ensure `webgateway` exists, and run `docker compose --env-file .env up -d`. Sign in as `root`. Startup can take several minutes and GitLab needs substantial RAM and disk space.

Back up `.env`, `config`, `logs`, and `data`. Use GitLab's application backup procedure for recoverable repository and database backups; the bind mounts alone are not a consistency guarantee.
