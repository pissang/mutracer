import {expect, it} from 'vitest';
import {publicApiSymbols, checkSdkExports, nativeLinkArguments} from '../../native/scripts/sdk-symbols.mjs';

it('normalizes only the MSVC default libraries compatible with /MD consumers', () => {
  expect(nativeLinkArguments('note: native-static-libs: /defaultlib:msvcrt /DEFAULTLIB:OLDNAMES.lib kernel32.lib\n', 'win32'))
    .toEqual(['msvcrt.lib', 'oldnames.lib', 'kernel32.lib']);
  for (const value of ['libcmt', 'msvcrtd', 'C:\\private\\msvcrt.lib', 'other']) {
    expect(() => nativeLinkArguments(`note: native-static-libs: /defaultlib:${value}\n`, 'win32'))
      .toThrow('Unsupported native SDK default library');
  }
  expect(nativeLinkArguments('note: native-static-libs: -lc -lm\n', 'linux')).toEqual(['-lc', '-lm']);
});

it('uses declarations, excluding comments, callback types and inline helpers', () => {
  expect(publicApiSymbols([`
    /* int32_t mt_private(void); */
    typedef void (*mt_callback)(int value);
    static inline void mt_helper(void) { mt_ignored(); }
    int32_t mt_create(const char *name,
      void (*callback)(int), unsigned *output);
    const char *mt_name(void);
    // void mt_obsolete(void);
  `, 'int32_t mt_create(const char *name, void (*callback)(int), unsigned *output);']))
    .toEqual(['mt_create', 'mt_name']);
});

it('fails on both lost public symbols and leaked dependency symbols', () => {
  expect(() => checkSdkExports(['mt_create', 'mt_destroy'], ['mt_create', 'oidnw_create']))
    .toThrow('missing: mt_destroy; extra: oidnw_create');
  expect(() => checkSdkExports(['mt_create'], ['mt_create'])).not.toThrow();
  expect(() => publicApiSymbols(['/* empty */'])).toThrow();
});

it('preserves the order and duplication of the platform linker arguments', () => {
  expect(nativeLinkArguments('note: native-static-libs: -lc++ -framework Metal -lc++\n'))
    .toEqual(['-lc++', '-framework', 'Metal', '-lc++']);
  expect(nativeLinkArguments('note: native-static-libs: kernel32.lib "C:\\SDK path\\runtime.lib"\r\n'))
    .toEqual(['kernel32.lib', 'C:\\SDK path\\runtime.lib']);
  expect(() => nativeLinkArguments('build failed')).toThrow();
});

it('removes terminal formatting from rustc linker arguments', () => {
  expect(nativeLinkArguments('\u001b[1m\u001b[92mnote\u001b[0m: native-static-libs: -lc++ -framework Metal -lc++\u001b[0m\n'))
    .toEqual(['-lc++', '-framework', 'Metal', '-lc++']);
  expect(nativeLinkArguments('\u001b[92mnote: native-static-libs: kernel32.lib "C:\\SDK path\\runtime.lib"\u001b[0m\r\n'))
    .toEqual(['kernel32.lib', 'C:\\SDK path\\runtime.lib']);
});
