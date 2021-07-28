module.exports = {
	branch: 'master',
	tagFormat: '${version}',
	plugins: [
		'@semantic-release/npm',
		'@semantic-release/github',
		['@semantic-release/git', {
			message: 'chore(release): ${nextRelease.version}\n\n${nextRelease.notes}',
			assets: [
				'CHANGELOG.md',
				'package.json',
				'package-lock.json'
			]
		}]
	]
};
