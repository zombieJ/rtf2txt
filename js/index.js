const { dialog } = require('electron').remote;
const convertToPlain = require('./lib/parser');
const FS = require('fs');
const PATH = require('path');
const { execSync } = require('child_process');

const _previewTmpl = _.template($('#previewTmpl').remove().text());
const isMac = process.platform === 'darwin';

const $srcInput = $('#srcInput');
const $tgtInput = $('#tgtInput');
const $exportFolder = $('#exportFolder');
const $ignoreFolder = $('#ignoreFolder');
const $tips = $('#tips');
const $convert = $('#convert');
const $preview = $('#preview');
const $previewFrom = $('#previewFrom');
const $previewTo = $('#previewTo');

function deleteFile(path) {
	if (FS.existsSync(path)) {
		FS.unlinkSync(path);
	}
}

function copyFile(src, tgt) {
	FS.createReadStream(src)
		.pipe(FS.createWriteStream(tgt));
}

if (!isMac) {
	dialog.showMessageBox({
		message: 'None Mac will roll down to software decode. This may work not correctly.',
	});
}

$('#selectSrc, #selectTgt').click(function() {
	const $input = $($(this).data('to'));
	const path = (dialog.showOpenDialog({properties: ['openDirectory']}) || [])[0] || '';
	if (!path) return;

	$input.val(path);
	checkFiles();
});

$('#srcInput, #tgtInput').keyup(checkFiles);

function checkFolder(name, path) {
	if (!path || path === '.') {
		$tips.text(`* ${name} folder path is empty`);
		return false;
	}

	if (!FS.existsSync(path) || !FS.lstatSync(path).isDirectory()) {
		$tips.text(`* ${name} folder path is not a directory`);
		return false;
	}

	return true;
}

function checkFiles() {
	const src = ($srcInput.val() || '').trim();
	const tgt = ($tgtInput.val() || '').trim();
	const srcPath = PATH.normalize(src);
	const tgtPath = PATH.normalize(tgt);

	$exportFolder.text('');

	// Local storage
	localStorage.setItem('src', src);
	localStorage.setItem('tgt', tgt);

	// Check able
	const check = (function () {
		if(!checkFolder('Source', srcPath)) return false;
		if(!checkFolder('Target', tgtPath)) return false;

		if (srcPath === tgtPath) {
			$tips.text('* Target folder path cannot be the same as source folder path');
			return false;
		}

		$tips.text('');
		return true;
	})();

	$convert.prop('disabled', !check);

	if (!check) {
		$previewFrom.text('');
		$previewTo.text('');
		$preview.hide();
		return;
	}

	$preview.show();

	// Export path
	const srcSeps = srcPath.split(PATH.sep);
	const exportPath = PATH.normalize(`${tgtPath}${PATH.sep}${srcSeps[srcSeps.length - 1]}`);
	$exportFolder.text(`[save to: ${exportPath}]`);

	// Pre-process
	refreshPreview();
}

function refreshPreview() {
	const src = ($srcInput.val() || '').trim();
	const srcPath = PATH.normalize(src);

	const ignore = $ignoreFolder.prop('checked');

	const files = fileQuery(srcPath);
	$previewFrom.html(_previewTmpl({ files, tmpl: _previewTmpl }));

	let toFiles = toQuery(files);
	if (ignore) toFiles = ignoreFolder(toFiles);
	$previewTo.html(_previewTmpl({ files: toFiles, tmpl: _previewTmpl }));
}

function fileQuery(path) {
	const files = [];

	const fileList = FS.readdirSync(path).filter(name => name !== '__MACOSX' && name !== '.DS_Store');
	fileList.forEach(name => {
		const subPath = PATH.join(path, name);
		if (FS.lstatSync(subPath).isFile()) {
			const suffix = ((name.match(/\.([\w\d_]+)$/) || [])[1] || '').toLowerCase();

			files.push({
				name,
				type: 'file',
				path: subPath,
				prefix: name.substr(0, name.length - suffix.length - 1),
				suffix,
			});
		} else if (FS.lstatSync(subPath).isDirectory()) {
			files.push({
				name,
				type: 'folder',
				path: subPath,
				files: fileQuery(subPath),
			});
		} else {
			console.warn('Unknown type:', subPath);
		}
	});

	files.sort(({ name: n1, type: t1 }, { name: n2, type: t2 }) => {
		if (t1 === 'folder' && t2 !== 'folder') return -1;
		if (t1 !== 'folder' && t2 === 'folder') return 1;
		return n1 < n2 ? -1 : 1;
	});

	return files;
}

function toQuery(fileList) {
	const files = fileList
		.filter(({ type, prefix, suffix }) => (
			type === 'folder' || (
				prefix[0] !== '~' && (suffix === 'rtf' || suffix === 'txt')
			)
		))
		.map(file => {
			const instance = Object.assign({}, file);
			instance.origin = file;

			if (file.type === 'file') {
				instance.name = `${file.prefix}.txt`;
			} else if (file.type === 'folder') {
				instance.files = toQuery(file.files);
			} else {
				console.warn('Type not found:', file);
			}

			return instance;
		});

	// Resolve name conflict
	const conflicts = {};
	files.forEach(file => {
		const { name } = file;
		const stack = conflicts[name] = conflicts[name] || [];
		stack.push(file);
	});

	Object.keys(conflicts).forEach(name => {
		const stack = conflicts[name];
		if (stack.length > 1) {
			stack.forEach(file => {
				if (file.suffix === 'rtf') {
					file.name = `${file.prefix}_rtf.txt`;
				}
			});
		}
	});

	return files;
}

function ignoreFolder(fileList) {
	return fileList.concat()
		.filter(file => {
			if (file.type === 'file') {
				return true;
			} else {
				file.files = ignoreFolder(file.files, file.name);

				if (file.files.length === 0) return false;
			}

			return true;
		});
}

// Preload if exist
if (localStorage.getItem('src') || localStorage.getItem('tgt')) {
	$srcInput.val(localStorage.getItem('src') || '');
	$tgtInput.val(localStorage.getItem('tgt') || '');

	checkFiles();
}

// ===============================================================
// =                           Convert                           =
// ===============================================================
function doConvert(fileList, path) {
	fileList.forEach(file => {
		const subPath = PATH.join(path, file.name);

		if (file.type === 'folder') {
			// Create folder if not exist
			if (!FS.existsSync(subPath)) FS.mkdirSync(subPath);

			doConvert(file.files, subPath);
		} else if (file.suffix === 'rtf') {
			if (!isMac) {
				// None Mac ENV
				const rtf = FS.readFileSync(file.path, 'utf8').toString();
				const txt = convertToPlain(rtf);
				FS.writeFileSync(subPath, txt, 'utf8');
			} else {
				// Mac ENV
				deleteFile('/tmp/rtf2txt.rtf');
				deleteFile('/tmp/rtf2txt.txt');

				execSync(`cp '${file.path}' /tmp/rtf2txt.rtf`);
				execSync(`textutil -convert txt /tmp/rtf2txt.rtf`);

				copyFile('/tmp/rtf2txt.txt', subPath);
				deleteFile('/tmp/rtf2txt.rtf');
				deleteFile('/tmp/rtf2txt.txt');
			}
		} else {
			copyFile(file.path, subPath);
		}
	});
}

$convert.click(function () {
	const src = ($srcInput.val() || '').trim();
	const tgt = ($tgtInput.val() || '').trim();
	const srcPath = PATH.normalize(src);
	const tgtPath = PATH.normalize(tgt);
	const ignore = $ignoreFolder.prop('checked');

	const files = fileQuery(srcPath);
	let toFiles = toQuery(files);
	if (ignore) toFiles = ignoreFolder(toFiles);

	$tips.text('Processing...');
	setTimeout(() => {
		try {
			const srcSeps = srcPath.split(PATH.sep);
			const exportPath = PATH.normalize(`${tgtPath}${PATH.sep}${srcSeps[srcSeps.length - 1]}`);
			console.log('Check folder:', exportPath);
			if (!FS.existsSync(exportPath)) {
				FS.mkdirSync(exportPath);
			}

			doConvert(toFiles, exportPath);
		} catch(err) {
			dialog.showMessageBox({
				message: 'OPS! ' + err.toString(),
			});
		}
		$tips.text('Done!');
	}, 100);
});
