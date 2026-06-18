const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: {
    inject: './src/inject/inject.ts',
    content: './src/content/content.ts',
    background: './src/background/background.ts',
    offscreen: './src/offscreen/offscreen.ts',
    popup: './src/popup/popup.ts',
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true,
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'manifest.json', to: '.' },
        { from: 'src/popup/popup.html', to: '.' },
        { from: 'src/offscreen/offscreen.html', to: '.' },
        { from: 'icons', to: 'icons' },
        { from: 'public', to: 'public', noErrorOnMissing: true },
      ],
    }),
  ],
  target: 'web',
};
