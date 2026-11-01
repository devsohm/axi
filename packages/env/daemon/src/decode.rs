use encoding_rs::{Decoder, UTF_8};

pub struct StreamDecoder {
    inner: Decoder,
}
impl Default for StreamDecoder {
    fn default() -> Self {
        Self::new()
    }
}
impl StreamDecoder {
    pub fn new() -> Self {
        Self {
            inner: UTF_8.new_decoder_with_bom_removal(),
        }
    }
    pub fn decode(&mut self, bytes: &[u8], last: bool) -> String {
        decode_into(&mut self.inner, bytes, last)
    }
}
pub fn range_decoder() -> Decoder {
    UTF_8.new_decoder_without_bom_handling()
}
pub fn decode_into(decoder: &mut Decoder, bytes: &[u8], last: bool) -> String {
    let mut text = String::with_capacity(
        decoder
            .max_utf8_buffer_length(bytes.len())
            .unwrap_or(bytes.len() * 3 + 16),
    );
    let (_, consumed, _) = decoder.decode_to_string(bytes, &mut text, last);
    debug_assert_eq!(consumed, bytes.len());
    text
}
pub fn starts_with_bom(bytes: &[u8]) -> bool {
    bytes.starts_with(&[239, 187, 191])
}
