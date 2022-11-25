(function (Prism) {

	// CAREFUL!
	// The following patterns are concatenated, so the group referenced by a back reference is non-obvious!

	var strings = [
		// normal string
		/"(?:\\[\s\S]|\$\([^)]+\)|\$(?!\()|`[^`]+`|[^"\\`$])*"/.source,
		/'[^']*'/.source,
		/\$'(?:[^'\\]|\\[\s\S])*'/.source,

		// here doc
		// 2 capturing groups
		/<<-?\s*(["']?)(\w+)\1\s[\s\S]*?[\r\n]\2/.source
	].join('|');

	Prism.languages['sl-shell-example'] = {
		'command': {
			pattern: RegExp(
				// user info
				/^/.source +
				'(?:' +
				(
					// <user> ":" ( <path> )?
					/[^\s@:$%*!/\\]+@[^\r\n@:$%*!/\\]+(?::[^\0-\x1F$%*?"<>:;|]+)?/.source +
					'|' +
					// <path>
					// Since the path pattern is quite general, we will require it to start with a special character to
					// prevent false positives.
					/[/~.][^\0-\x1F$%*?"<>@:;|]*/.source
				) +
				')?' +
				// shell symbol
				/[$%](?=\s)/.source +
				// bash command
				/(?:[^\\\r\n \t'"<$]|[ \t](?:(?!#)|#.*$)|\\(?:[^\r]|\r\n?)|\$(?!')|<(?!<)|<<str>>)+/.source.replace(/<<str>>/g, function () { return strings; }),
				'm'
			),
			greedy: true,
			inside: {
				'info': {
					// foo@bar:~/files$ exit
					// foo@bar$ exit
					// ~/files$ exit
					pattern: /^[^$%]+/,
					alias: 'punctuation',
					inside: {
						'user': /^[^\s@:$%*!/\\]+@[^\r\n@:$%*!/\\]+/,
						'punctuation': /:/,
						'path': /[\s\S]+/
					}
				},
				'shell-command': {
					pattern: /(^[$%]\s*)\S[\s\S]*/,
					lookbehind: true,
				},
				'shell-prompt': {
					pattern: /^[$%]/,
				}
			}
		},
		'smartlog': {
			// multiple lines, starting with "o  " or "@  ",
			// ending with "~" on a line by itself
			pattern: /\n *[o@]  (\n|.)*(\n~)/g,
			inside: {
				'sl-public': /  ([0-9a-f]{9}) /,
				'sl-active-bookmark': /  [a-z_]+\*\n/,
				'sl-bookmark': / remote\/([a-z0-9_]+)/,
				'sl-diff': / #[0-9]+/,
				'sl-signal-okay': /✓/,
				'sl-signal-failed': /✗/,
				'sl-signal-warning': /‼/,
				'sl-signal-in-progress': /⋯/,
			}
		},
		'comment': /#.*/,
		'output': /.(?:.*(?:[\r\n]|.$))*/,
	};
}(Prism));
