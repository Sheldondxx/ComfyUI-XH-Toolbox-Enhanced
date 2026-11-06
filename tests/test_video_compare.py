"""Synthetic fixtures: no ComfyUI install, models or personal videos required."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class FileVideo:
    def __init__(self, path, dimensions=(160, 90), fps=8, frames=4, duration=0.5):
        self.path = str(path)
        self.dimensions = dimensions
        self.fps = fps
        self.frames = frames
        self.duration = duration

    def get_stream_source(self):
        return self.path

    def get_dimensions(self):
        return self.dimensions

    def get_frame_rate(self):
        return self.fps

    def get_frame_count(self):
        return self.frames

    def get_duration(self):
        return self.duration


class VideoCompareTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for kind in ('input', 'output', 'temp'):
            (self.root / kind).mkdir()
        paths = types.ModuleType('folder_paths')
        paths.get_input_directory = lambda: str(self.root / 'input')
        paths.get_output_directory = lambda: str(self.root / 'output')
        paths.get_temp_directory = lambda: str(self.root / 'temp')
        paths.get_save_image_path = self.save_path
        latest = types.ModuleType('comfy_api.latest')
        latest.InputImpl = types.SimpleNamespace(VideoFromFile=FileVideo)
        api = types.ModuleType('comfy_api')
        api.latest = latest
        package = types.ModuleType('xh_compare_test')
        package.__path__ = [str(ROOT / 'image_tools/py')]
        self.modules = patch.dict(sys.modules, {'folder_paths': paths, 'comfy_api': api,
                                 'comfy_api.latest': latest, 'xh_compare_test': package})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        for name in ('xh_compare_test.video_label', 'xh_compare_test.video_compare'):
            sys.modules.pop(name, None)
        spec = importlib.util.spec_from_file_location('xh_compare_test.video_compare', ROOT / 'image_tools/py/video_compare.py')
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.node = self.module.XHCompareVideos()
        for i in range(4):
            (self.root / 'input' / f'clip{i}.mp4').write_bytes(b'fixture')

    def save_path(self, prefix, output_dir, width, height):
        prefix = Path(prefix)
        folder = Path(output_dir) / prefix.parent
        folder.mkdir(parents=True, exist_ok=True)
        return str(folder), prefix.name, 1, str(prefix.parent), prefix.name

    def video(self, i):
        return FileVideo(self.root / 'input' / f'clip{i}.mp4')

    def selection(self, i):
        return {'source_type': 'input', 'file_path': f'clip{i}.mp4'}

    def compare(self, source=None, output=None, **settings):
        result = self.node.compare_videos(source=source, output=output, compare_video=json.dumps(settings))
        payloads = result['ui']['compare_videos']
        self.assertIsInstance(payloads, list, 'ComfyUI merges UI values as lists')
        self.assertEqual(len(payloads), 1)
        self.assertIsInstance(payloads[0], dict)
        return payloads[0]

    def test_empty_inputs_use_list_payload(self):
        self.assertEqual(self.compare()['hint'], 'no_input')

    def test_partial_failure_keeps_valid_preview(self):
        result = self.compare(self.video(0), FileVideo(self.root / 'missing.mp4'))
        self.assertEqual(len(result['videos']), 1)
        self.assertTrue(result['hint'].startswith('error:'))

    def test_legacy_two_cell_setting_does_not_drop_added_files(self):
        result = self.compare(self.video(0), self.video(1), max_cells=2,
                              selections=[self.selection(2), self.selection(3)])
        self.assertEqual(len(result['videos']), 4)
        self.assertFalse(result['truncated'])
        self.assertEqual([v['origin'] for v in result['videos']], ['source', 'output', 'select', 'select'])

    def test_four_selected_files_without_wires(self):
        result = self.compare(max_cells=2, selections=[self.selection(i) for i in range(4)])
        self.assertEqual(len(result['videos']), 4)
        self.assertTrue(all(v['origin'] == 'select' for v in result['videos']))

    def test_more_than_four_is_reported(self):
        result = self.compare(self.video(0), self.video(1), selections=[self.selection(i) for i in range(4)])
        self.assertEqual(len(result['videos']), 4)
        self.assertTrue(result['truncated'])

    def test_preview_does_not_save_output(self):
        result = self.compare(self.video(0), self.video(1), labels=['Model A\nseed=42', 'Model B'])
        self.assertEqual(result['videos'][0]['label'], 'Model A\nseed=42')
        self.assertFalse(result['saved'])
        self.assertIsNone(result['output_video'])
        self.assertEqual(list((self.root / 'output').iterdir()), [])

    def test_missing_ffmpeg_is_actionable(self):
        with patch.object(self.module.shutil, 'which', return_value=None):
            with self.assertRaisesRegex(RuntimeError, 'ffmpeg'):
                self.compare(self.video(0), save_output=True)

    def test_failed_encode_removes_partial_output(self):
        def fail(command, **kwargs):
            Path(command[-1]).write_bytes(b'partial')
            return types.SimpleNamespace(returncode=1, stderr='synthetic encode failure')
        with patch.object(self.module.shutil, 'which', return_value='ffmpeg'):
            with patch.object(self.module.subprocess, 'run', side_effect=fail):
                with self.assertRaisesRegex(RuntimeError, 'synthetic encode failure'):
                    self.compare(self.video(0), labels=[''], save_output=True)
        self.assertEqual(list((self.root / 'output').rglob('*.mp4')), [])

    def test_multiline_label_layer_is_transparent_outside_text(self):
        from xh_compare_test.video_label import render_label_overlay
        layer = render_label_overlay(320, 180, '中文标签\nCFG=1.0; seed=42', 16)
        self.assertEqual(layer.mode, 'RGBA')
        self.assertEqual(layer.size, (320, 180))
        self.assertEqual(layer.getpixel((319, 179)), (0, 0, 0, 0))
        self.assertIsNotNone(layer.getchannel('A').getbbox())

    def make_clips(self):
        ffmpeg = shutil.which('ffmpeg')
        if not ffmpeg or not shutil.which('ffprobe'):
            self.skipTest('FFmpeg and ffprobe are required for export integration tests')
        for i, color in enumerate(('red', 'green', 'blue', 'yellow')):
            command = [ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
                       f'color=c={color}:s=160x90:r=8:d=0.5']
            if i == 1:
                command += ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-c:a', 'aac']
            command += ['-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p',
                        str(self.root / 'input' / f'clip{i}.mp4')]
            subprocess.run(command, check=True, capture_output=True)

    def assert_export(self, payload, dimensions):
        self.assertTrue(payload['saved'])
        ref = payload['output_video']
        path = self.root / 'output' / ref['subfolder'] / ref['filename']
        probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)]))
        video = next(s for s in probe['streams'] if s['codec_type'] == 'video')
        self.assertEqual((video['width'], video['height']), dimensions)
        self.assertEqual(video['avg_frame_rate'], '8/1')
        self.assertEqual(int(video['nb_frames']), 4)
        self.assertAlmostEqual(float(probe['format']['duration']), 0.5, places=2)
        self.assertEqual(len(list((self.root / 'output').rglob('*.mp4'))), 1)
        return probe

    def test_two_video_export_preserves_audio(self):
        self.make_clips()
        payload = self.compare(self.video(0), self.video(1), layout='vertical',
                               labels=['参数 A\nseed=42', '参数 B'], save_output=True)
        probe = self.assert_export(payload, (160, 180))
        self.assertTrue(any(s['codec_type'] == 'audio' for s in probe['streams']))

    def test_four_video_grid_export(self):
        self.make_clips()
        payload = self.compare(self.video(0), self.video(1), layout='horizontal',
                               selections=[self.selection(2), self.selection(3)],
                               labels=['A', 'B', 'C', 'D'], save_output=True)
        self.assert_export(payload, (320, 180))

    def test_single_video_with_blank_label(self):
        self.make_clips()
        payload = self.compare(self.video(0), labels=[''], save_output=True)
        self.assert_export(payload, (160, 90))

    def test_different_size_and_rate_follow_first_video(self):
        self.make_clips()
        target = self.root / 'input' / 'different.mp4'
        subprocess.run([shutil.which('ffmpeg'), '-hide_banner', '-loglevel', 'error', '-y',
                        '-f', 'lavfi', '-i', 'color=c=blue:s=192x96:r=12:d=0.75',
                        '-c:v', 'libx264', '-threads', '1', str(target)], check=True, capture_output=True)
        payload = self.compare(self.video(0), FileVideo(target, (192, 96), 12, 9, 0.75),
                               layout='horizontal', labels=['', ''], save_output=True)
        self.assert_export(payload, (320, 90))

    def test_shorter_second_video_does_not_truncate_first(self):
        self.make_clips()
        target = self.root / 'input' / 'short.mp4'
        subprocess.run([shutil.which('ffmpeg'), '-hide_banner', '-loglevel', 'error', '-y',
                        '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=8:d=0.25',
                        '-c:v', 'libx264', '-threads', '1', str(target)], check=True, capture_output=True)
        payload = self.compare(self.video(0), FileVideo(target, frames=2, duration=0.25),
                               layout='horizontal', labels=['', ''], save_output=True)
        self.assert_export(payload, (320, 90))


if __name__ == '__main__':
    unittest.main()
