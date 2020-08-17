#chg-compatible

  $ configure modern

  $ setconfig configs.loaddynamicconfig=True
  $ export HG_TEST_DYNAMICCONFIG="$TESTTMP/test_hgrc"
  $ cat > test_hgrc <<EOF
  > [section]
  > key=value
  > EOF

  $ hg init client
  $ cd client

Verify it can be manually generated

  $ hg debugdynamicconfig
  $ cat .hg/hgrc.dynamic
  # version=4.4.2* (glob)
  # Generated by `hg debugdynamicconfig` - DO NOT MODIFY
  [section]
  key=value
  
  $ hg config section.key
  value

Verify it can be automatically synchronously generated

  $ rm .hg/hgrc.dynamic
  $ hg config section.key
  value
  $ cat .hg/hgrc.dynamic
  # version=4.4.2* (glob)
  # Generated by `hg debugdynamicconfig` - DO NOT MODIFY
  [section]
  key=value
  
Verify it can be automatically asynchronously regenerated

  $ cat > $TESTTMP/test_hgrc <<EOF
  > [section]
  > key=value
  > [section2]
  > key2=value2
  > EOF
  $ hg config section2.key2 --config configs.generationtime=30 # No regen, because too soon
  [1]
  $ sleep 1
  $ hg status --config configs.generationtime=1 # Regen, because lower time limit
  $ sleep 0.5 # Time for background process to complete
  $ hg config section2.key2
  value2
  $ cat .hg/hgrc.dynamic
  # version=4.4.2* (glob)
  # Generated by `hg debugdynamicconfig` - DO NOT MODIFY
  [section]
  key=value
  
  [section2]
  key2=value2
  
Verify mtime is updated even if no change is made
  $ python -c "import stat, os; print(os.stat(os.path.join('.hg', 'hgrc.dynamic'))[stat.ST_MTIME])" > $TESTTMP/mtime1
  $ hg status --config configs.generationtime=60 # No regen, because high time limit
  $ python -c "import stat, os; print(os.stat(os.path.join('.hg', 'hgrc.dynamic'))[stat.ST_MTIME])" > $TESTTMP/mtime2
  $ diff -q $TESTTMP/mtime1 $TESTTMP/mtime2 >/dev/null 2>/dev/null

  $ sleep 1
  $ hg status --config configs.generationtime=1 # Regen, because low time limit
  $ python -c "import stat, os; print(os.stat(os.path.join('.hg', 'hgrc.dynamic'))[stat.ST_MTIME])" > $TESTTMP/mtime3
  $ diff -q $TESTTMP/mtime2 $TESTTMP/mtime3 >/dev/null 2>/dev/null
  [1]

Validate dynamic config
  $ cat > $TESTTMP/input_hgrc <<EOF
  > [section]
  > key=valueX
  > EOF
  $ echo "%include $TESTTMP/input_hgrc" >> .hg/hgrc
  $ hg status --config configs.validatedynamicconfig=True --config configs.mismatchwarn=True --config configs.testdynamicconfigsubset=input_hgrc --config configs.legacylist=section.key,section2.key2
  Config mismatch: section2.key2 has 'value2' (dynamic) vs 'None' (file)
  Config mismatch: section.key has 'value' (dynamic) vs 'valueX' (file)
  Config mismatch: section2.key2 has 'value2' (dynamic) vs 'None' (file)
  Config mismatch: section.key has 'value' (dynamic) vs 'valueX' (file)

Verify we generate and load from a shared repo

  $ cd ..
  $ enable share
  $ hg init shared
  $ hg share shared shared_copy
  updating working directory
  0 files updated, 0 files merged, 0 files removed, 0 files unresolved
  $ cd shared_copy
- Test the case where sharedpath ends in newlines.
  $ echo >> .hg/sharedpath
  $ echo >> .hg/sharedpath
  $ hg debugdynamicconfig
  $ test -f .hg/hgrc.dynamic
  [1]
  $ cat ../shared/.hg/hgrc.dynamic
  # version=4.4.2* (glob)
  # Generated by `hg debugdynamicconfig` - DO NOT MODIFY
  [section]
  key=value
  
  [section2]
  key2=value2
  
  $ hg config section.key
  value

Verify we regenerate configs if the Mercurial version differs
  $ cat > ../shared/.hg/hgrc.dynamic <<EOF
  > # version=1
  > [section3]
  > key3=value3
  > EOF
  $ hg config section3.key3
  [1]
  $ hg config section.key
  value
  $ cat ../shared/.hg/hgrc.dynamic
  # version=4.4.2* (glob)
  # Generated by `hg debugdynamicconfig` - DO NOT MODIFY
  [section]
  key=value
  
  [section2]
  key2=value2
  
Verify we don't regenerate configs if the Mercurial version hasn't changed
  $ cat >> ../shared/.hg/hgrc.dynamic <<EOF
  > [section3]
  > key3=value3
  > EOF
  $ hg config section3.key3
  value3

Verify we load and verify dynamicconfigs during clone
  $ newserver server
  $ cd $TESTTMP
  $ export HG_TEST_DYNAMICCONFIG="$TESTTMP/test_hgrc"
  $ cat > test_hgrc <<EOF
  > [hooks]
  > pretxnclose = printf "Hook ran!\n"
  > EOF
  $ cat > good_hgrc <<EOF
  > [hooks]
  > pretxnclose = printf "Hook ran!\n"
  > [foo]
  > bar=True
  > EOF
  $ hg clone ssh://user@dummy/server client2 --configfile $TESTTMP/good_hgrc --config configs.testdynamicconfigsubset=good_hgrc --config configs.validatedynamicconfig=True --config configs.mismatchwarn=True --config configs.legacylist=foo.bar
  Config mismatch: foo.bar has 'None' (dynamic) vs 'True' (file)
  no changes found
  Hook ran!
  updating to branch default
  0 files updated, 0 files merged, 0 files removed, 0 files unresolved
  Hook ran!
  Hook ran!
  $ cat client2/.hg/hgrc.dynamic
  # version=4.4.2* (glob)
  # Generated by `hg debugdynamicconfig` - DO NOT MODIFY
  [hooks]
  pretxnclose=printf "Hook ran!\n"
  
Verify unicode characters in configs can be logged to our sampling extension
  $ unset SCM_SAMPLING_FILEPATH
  $ cat >> good_hgrc <<EOF
  > [foo]
  > bar = Å
  > EOF
  $ hg -R client2 log -q -r . --configfile $TESTTMP/good_hgrc --config configs.validatedynamicconfig=True --config configs.mismatchsampling=1 --config extensions.sampling= --config sampling.filepath=$TESTTMP/sampling.log --config sampling.key.config_mismatch=mismatches --config configs.testdynamicconfigsubset=good_hgrc --config configs.legacylist=foo.bar,
  000000000000
  $ cat $TESTTMP/sampling.log
  {"category": "mismatches", "data": {"actual": null, "config": "foo.bar", "expected": "\\u00c5", "metrics_type": "config_mismatch", "msg": "Config mismatch: foo.bar has 'None' (dynamic) vs '\\u00c5' (file)\\n", "repo": "reponame-default"}}\x00{"category": "mismatches", "data": {"actual": null, "config": "foo.bar", "expected": "\\u00c5", "metrics_type": "config_mismatch", "msg": "Config mismatch: foo.bar has 'None' (dynamic) vs '\\u00c5' (file)\\n", "repo": "reponame-default"}}\x00 (no-eol) (esc)

Verify hgrc.dynamic is updated even if the original command is outside the repo
  $ echo "[junk_on_the_end]" >> client2/.hg/hgrc.dynamic
  $ sleep 1
  $ hg -R client2 status --config configs.generationtime=1
  $ sleep 1
  $ cat client2/.hg/hgrc.dynamic
  # version=4.4.2* (glob)
  # Generated by `hg debugdynamicconfig` - DO NOT MODIFY
  [hooks]
  pretxnclose=printf "Hook ran!\n"
  
Verify configs.disallowlist removes old configs
- Both good_hgrc and bad_hgrc contain a foo.bar value. bad_hgrc is an old rc and therefore
- its value should be removed even though it comes later in the load order.
  $ cat > good_hgrc <<EOF
  > [foo]
  > bar = good
  > EOF
  $ cat > bad_hgrc <<EOF
  > [foo]
  > bar = bad
  > EOF
  $ hg -R client2 config foo.bar --configfile $TESTTMP/good_hgrc --configfile $TESTTMP/bad_hgrc --config configs.validatedynamicconfig=True --config configs.testdynamicconfigsubset=bad_hgrc --config configs.legacylist=foo.bar
  bad
  $ hg -R client2 config foo.bar --configfile $TESTTMP/good_hgrc --configfile $TESTTMP/bad_hgrc --config configs.validatedynamicconfig=True --config configs.testdynamicconfigsubset=bad_hgrc --config configs.legacylist=foo.bar --config configs.disallowlist=foo.bar
  good
