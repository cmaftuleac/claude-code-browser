//! Tiny Rust sample.

use std::collections::HashMap;

pub fn word_counts(text: &str) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for word in text.split_whitespace() {
        let clean: String = word
            .chars()
            .filter(|c| c.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect();
        if !clean.is_empty() {
            *counts.entry(clean).or_insert(0) += 1;
        }
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_words_case_insensitively() {
        let c = word_counts("The quick brown fox. The lazy dog!");
        assert_eq!(c.get("the"), Some(&2));
        assert_eq!(c.get("fox"), Some(&1));
    }
}
