# Repository instructions

- Never remove, relocate, or replace arguments in `docker-compose.yml` unless the user explicitly asks for that exact Compose change.
- Requests to add or tune values in `models/router-config.ini` authorize changes only to that file unless the user explicitly expands the scope.
- If router preset values conflict with Compose arguments, preserve both and report the precedence conflict to the user. Do not resolve it by editing Compose without explicit permission.
