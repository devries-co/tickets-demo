// Sample names for the "preview with sample names" mode only. They are
// generated in the browser from common given and family names, are labelled
// as demonstration data on screen, and are never stored, searchable or
// counted. They exist so the artwork can be judged before real names arrive.

const GIVEN = [
	"Amara", "Anders", "Aiko", "Beatriz", "Callum", "Chidi", "Dalia", "Dmitri", "Eleni", "Emeka", "Farah", "Finn",
	"Giulia", "Hamza", "Hana", "Ingrid", "Isaac", "Jun", "Kavya", "Kofi", "Leila", "Lucas", "Mateo", "Mei", "Nadia",
	"Niamh", "Omar", "Oksana", "Pablo", "Priya", "Quentin", "Rosa", "Rahul", "Sione", "Sofia", "Tariq", "Thandi",
	"Ulla", "Viktor", "Wanjiru", "Xavier", "Yara", "Yusuf", "Zofia", "Marguerite", "Tomás", "Björn", "Chloé", "Søren",
	"Zeynep", "Nguyen", "Ama", "Elias", "Noor", "Ravi", "Greta", "Hiro", "Ines", "Jamal", "Katarzyna",
];

const FAMILY = [
	"Adeyemi", "Andersson", "Bianchi", "Castillo", "Chen", "Dubois", "Eriksen", "Fernández", "García", "Haddad",
	"Ivanova", "Jensen", "Kaya", "Khan", "Kowalski", "Lindqvist", "Mbeki", "Moreau", "Nakamura", "Novák", "Okafor",
	"O'Brien", "Papadopoulos", "Patel", "Pereira", "Rossi", "Sato", "Schmidt", "Silva", "Singh", "Tanaka", "Tran",
	"Ueda", "Vargas", "Wang", "Williams", "Yilmaz", "Zhang", "Müller", "Nyström", "Þórsson", "Çelik", "Ng", "Mensah",
	"Hernández", "Johansson", "Kim", "Laurent", "Mahlangu", "Reyes",
];

function hash(n: number) {
	let h = (n + 1) * 2654435761;
	h ^= h >>> 15;
	h = Math.imul(h, 2246822519);
	h ^= h >>> 13;
	return h >>> 0;
}

export function demoName(slot: number) {
	const h = hash(slot);
	return `${GIVEN[h % GIVEN.length]} ${FAMILY[(h >>> 8) % FAMILY.length]}`;
}
