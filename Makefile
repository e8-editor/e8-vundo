# make test: run the ERT tests in test/ with gnista --batch, as CI does.
# make types: type-check the package against the Gnista on PATH.
# GNISTA=/path/to/gnista make test, to use another Gnista.

GNISTA ?= gnista
TESTS := $(wildcard test/*-tests.ts)
.PHONY: test types

test:
	$(GNISTA) --batch -L . $(foreach t,$(TESTS),-l $(t)) -f ert-run-tests-batch-and-exit

types:
	$(GNISTA) --print-types .gnista
	tsc -p .
