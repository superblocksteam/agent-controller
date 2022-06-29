# agent-controller

This repository contains the source code of the controller component in the agent platform.
The controller responsible for the following:

- Registration against Superblocks Cloud
- Orchestrating the execution of a workflow
- Polling of scheduled jobs
- Managing a fleet of workers
- Reporting diagnostics and metrics to Superblocks Cloud
- Exposing metrics via Prometheus
- Serving agent endpoints

Learn more about the On-Premise Agent [here](https://docs.superblocks.com/on-premise-agent/overview).

## Build locally

A Makefile has been included for convenience.

### Requirements

- Node v16
- Python v3.10

To transpile the source files:

```bash
make build
```

To build the docker image:

```bash
make docker
```

To build the docker image and launch it via docker-compose:

```bash
make docker-up
```

To run unit tests:

```bash
make test
```
