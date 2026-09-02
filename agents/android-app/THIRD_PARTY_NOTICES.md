# Third-party notices

## 0xNuller / DG-Kit

The DG-Lab Coyote V2/V3 GATT constants, packet layouts, waveform definitions,
and safety defaults in the Android integration are adapted from
[`0xNullAI/0xNuller`](https://github.com/0xNullAI/0xNuller), commit
`97d8661d08d49dac213e629a325a66d273086d38`.

Copyright (c) 2026 0xNullAI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## AutoAccounting

Live Dashboard interoperates with AutoAccounting only through its existing
loopback HTTP endpoint (`http://127.0.0.1:52045/bill/range`). It does not copy
AutoAccounting's recognition rules, hook implementation, OCR implementation,
or database code.
