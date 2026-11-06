# make test: run the ERT tests in test/ with e8 --batch, as CI does.
# make types: type-check the package against the E8 on PATH.
# E8=/path/to/e8 make test, to use another E8.

E8 ?= e8
TESTS := $(wildcard test/*-tests.ts)
.PHONY: test types

test:
	$(E8) --batch -L . $(foreach t,$(TESTS),-l $(t)) -f ert-run-tests-batch-and-exit

types:
	$(E8) --print-types .e8
	tsc -p .
