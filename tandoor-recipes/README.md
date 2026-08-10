# Tandoor Recipes

Recipe management at `https://tandoor.${DOMAIN}`.

Copy `.env.example` to `.env`, replace the database password and `SECRET_KEY`, ensure `webgateway` exists, and run `docker compose --env-file .env up -d`. Create an administrator with `docker compose --env-file .env exec tandoor python manage.py createsuperuser`.

Back up `.env`, `mediafiles`, `staticfiles`, and a consistent copy or dump of `postgres`.
