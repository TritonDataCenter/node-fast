#
# Copyright (c) 2016, Joyent, Inc. All rights reserved.
#
# Makefile: top-level Makefile
#
# This Makefile contains only repo-specific logic and uses included makefiles
# to supply common targets (javascriptlint, jsstyle, restdown, etc.), which are
# used by other repos as well.
#

#
# Tools
#
CATEST		 = deps/catest/catest
NPM		 = npm
NODE		 = node

#
# Files
#
JSON_FILES	 = package.json
BASH_FILES	 = $(wildcard test/*.sh)
JS_FILES	:= bin/fastbench \
		   bin/fastcall \
		   bin/fastserve \
		   $(shell find lib test -name '*.js' | \
			grep -v ^test/compat/node_modules)
CATEST_FILES	 = $(shell find test -name 'tst.*.js' | \
			grep -v ^test/compat/node_modules)
JSL_FILES_NODE	 = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSL_CONF_NODE	 = tools/jsl.node.conf

include ./test/compat/Makefile.compat.defs

.PHONY: all
all:
	$(NPM) install
CLEAN_FILES += node_modules

.PHONY: test
test: | $(CATEST)
	$(CATEST) $(CATEST_FILES)
	@echo Note: Compatibility tests need to be run manually with \
	    \"make test-compat\".

$(CATEST): deps/catest/.git

include ./tools/mk/Makefile.deps
include ./tools/mk/Makefile.targ
include ./test/compat/Makefile.compat.targ
