.PHONY: build up down logs dev

# Build the image
build:
	docker compose build

# Build + run in the foreground (single command to bring it up)
up:
	docker compose up --build

# Run detached
start:
	docker compose up --build -d

down:
	docker compose down

logs:
	docker compose logs -f

# Local (no docker) run for fast iteration
dev:
	npm install && npm run dev
