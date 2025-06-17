
import TreeMap, { Comparable } from 'ts-treemap';

function compareNumbers(a: number, b: number) {
    return a - b;
}

export class Range<T = number> implements Comparable<Range<T>> {
    private readonly _start: T;
    private readonly _end: T;

    private readonly _comparator: (a: T, b: T) => number;

    constructor(start: T, end: T, comparator: (a: T, b: T) => number) {
        this._start = start;
        this._end = end;

        this._comparator = comparator;
    }

    get start(): T {
        return this._start;
    }

    get end(): T {
        return this._end;
    }

    get comparator(): (a: T, b: T) => number {
        return this._comparator;
    }

    contains(n: T): boolean {
        return this._comparator(this._start, n) <= 0 && this._comparator(n, this._end) <= 0;
    }

    intersects(range: Range<T>): boolean {
        return this.contains(range.start) || this.contains(range.end);
    }

    inside(range: Range<T>): boolean {
        return this._comparator(this.start, range.start) >= 0 && this._comparator(this.end, range.end) <= 0;
    }

    toString(): string {
        return `[${this.start}; ${this.end}]`
    }

    compare(other: Range<T>): number {
        const comp1 = this._comparator(this.start, other.start);

        return comp1 != 0 
                ? comp1
                : this._comparator(this.end, other.end);
    }
}

function forEachIter<T>(
    it: IterableIterator<T>, 
    applyFn: (arg: T) => void,
    breakFn: (arg: T) => boolean = _ => false
): void {
    let result = it.next();

    while (!result.done && !breakFn(result.value)) {
        applyFn(result.value);

        result = it.next();
    }
}

export class NumberRange extends Range<number> {
    constructor(start: number, end: number) {
        super(start, end, compareNumbers);
    }
}

export class RangeBinTree<T, RType = number> {
    private readonly _node: T;

    private readonly _range: Range<RType>;

    private readonly _children: TreeMap<Range<RType>, RangeBinTree<T, RType>>;

    constructor(range: Range<RType>, node: T) {
        this._range = range;
        this._node = node;

        this._children = new TreeMap();
    }

    get node(): T {
        return this._node;
    }

    get range(): Range<RType> {
        return this._range;
    }

    get children(): TreeMap<Range<RType>, RangeBinTree<T, RType>> {
        return this._children;
    }

    addChild(range: Range<RType>, child: T): void {
        this.addChildNode(new RangeBinTree<T, RType>(range, child));
    }

    addChildNode(child: RangeBinTree<T, RType>): void {
        this._children.set(child.range, child);
    }

    addChildren(children: [Range<RType>, T][]) {
        children.forEach(p => this.addChild(p[0], p[1]));
    }

    addChildNodes(children: RangeBinTree<T, RType>[]) {
        children.forEach(this.addChildNode);
    }

    find(range: Range<RType>): RangeBinTree<T, RType>[] {
        const nodes: RangeBinTree<T, RType>[] = [];

        const lowerKeysIter = this._children.splitLower(range).reverseKeys();

        forEachIter(
            lowerKeysIter,
            r => nodes.push(this._children.get(r)!),
            r => !r.intersects(range) && !r.inside(range)
        );

        const higherEntriesIter = this._children.splitHigher(range, false).entries();

        forEachIter(
            higherEntriesIter,
            entry => nodes.push(entry[1]),
            entry => {
                const r = entry[0];

                return !r.intersects(range) && !r.inside(range)
            }
        );

        return nodes;
    }
}
