import importlib.util
from pathlib import Path
import sys
import types
import unittest

TORCH_AVAILABLE = importlib.util.find_spec('torch') is not None
if TORCH_AVAILABLE:
    import torch
    package = types.ModuleType('xh_label_test')
    package.__path__ = [str(Path(__file__).resolve().parents[1] / 'image_tools/py')]
    sys.modules[package.__name__] = package
    spec = importlib.util.spec_from_file_location('xh_label_test.video_label_node', Path(package.__path__[0]) / 'video_label_node.py')
    label_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(label_module)


@unittest.skipUnless(TORCH_AVAILABLE, 'Standalone IMAGE node requires PyTorch')
class VideoLabelNodeTests(unittest.TestCase):
    def setUp(self):
        self.node = label_module.XHVideoLabel()

    def test_blank_label_keeps_frames(self):
        images = torch.rand(2, 64, 128, 3)
        self.assertIs(self.node.apply_label(images, ' \n ', 28)[0], images)

    def test_multiline_chinese_only_changes_top_left(self):
        images = torch.full((2, 640, 1152, 3), 0.3)
        output, = self.node.apply_label(images, '加速视频\n模型：示例\nsteps=8 | seed=42', 28)
        self.assertEqual(output.shape, images.shape)
        self.assertTrue(torch.equal(output[0], output[1]))
        self.assertTrue(torch.equal(output[:, 170:, :, :], images[:, 170:, :, :]))
        self.assertTrue(torch.equal(output[:, :, 750:, :], images[:, :, 750:, :]))
        self.assertGreater(float(output[:, :150, :600].max()), 0.9)

    def test_long_parameter_line_wraps(self):
        images = torch.zeros(1, 320, 240, 3)
        output, = self.node.apply_label(images, '生成参数：' + 'steps=8,seed=42,CFG=1.0,' * 3, 18)
        self.assertTrue(torch.equal(output[:, :, -5:, :], images[:, :, -5:, :]))
        self.assertGreater(float(output[:, 80:250, :].max()), 0.5)

    def test_transparent_frames_get_visible_labels(self):
        images = torch.zeros(2, 100, 300, 4)
        output, = self.node.apply_label(images, '中文标签', 20)
        self.assertTrue(torch.isfinite(output).all())
        self.assertGreater(float(output[..., 3].max()), 0.9)
        self.assertEqual(float(output[:, -1, -1].sum()), 0)

    def test_preserves_float16_dtype(self):
        images = torch.zeros(1, 100, 300, 3, dtype=torch.float16)
        output, = self.node.apply_label(images, '标签', 20)
        self.assertEqual(output.dtype, images.dtype)


if __name__ == '__main__':
    unittest.main()
