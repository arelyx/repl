.PHONY: runner versions update-versions up down logs smoke

runner:            ## Build the polyglot repl image (slow the first time)
	runner/build.sh replit-polyglot:latest

versions:          ## Print every toolchain version in the runner image
	docker run --rm --entrypoint replot-versions replit-polyglot:latest

update-versions:   ## Bump runner/Dockerfile pins to the latest stable releases
	python3 runner/update-versions.py

up: runner         ## Build and start the stack on http://localhost:8380
	mkdir -p $$(grep ^REPLS_HOST_DIR .env | cut -d= -f2)
	docker compose up -d --build

down:              ## Stop the stack and all repl containers
	-docker ps -aq --filter label=replot.repl | xargs -r docker rm -f
	docker compose down

logs:
	docker compose logs -f --tail=100

smoke:             ## End-to-end test through nginx (needs aiohttp)
	python3 scripts/smoke_test.py
