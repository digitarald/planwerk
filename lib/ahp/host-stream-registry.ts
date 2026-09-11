export interface HostStreamSubscriber<Event> {
  id: number;
  workspaceScope: Set<string> | null;
  send(event: Event): void;
  close(): void;
}

export interface HostStreamPartition<Card, Event, Resource> {
  generation: number;
  hostUrl: string;
  cards: Card[];
  initialized: boolean;
  resource: Resource;
  subscribers: Map<number, HostStreamSubscriber<Event>>;
}

export class HostStreamRegistry<Card, Event, Resource> {
  private readonly partitions = new Map<
    string,
    HostStreamPartition<Card, Event, Resource>
  >();
  private readonly createResource: (hostUrl: string) => Resource;
  private readonly disposeResource: (resource: Resource) => void;
  private nextGeneration = 0;

  constructor(
    createResource: (hostUrl: string) => Resource,
    disposeResource: (resource: Resource) => void,
  ) {
    this.createResource = createResource;
    this.disposeResource = disposeResource;
  }

  subscribe(
    hostUrl: string,
    subscriber: HostStreamSubscriber<Event>,
  ): {
    partition: HostStreamPartition<Card, Event, Resource>;
    firstForHost: boolean;
  } {
    let partition = this.partitions.get(hostUrl);
    const firstForHost = !partition;
    if (!partition) {
      partition = {
        generation: ++this.nextGeneration,
        hostUrl,
        cards: [],
        initialized: false,
        resource: this.createResource(hostUrl),
        subscribers: new Map(),
      };
      this.partitions.set(hostUrl, partition);
    }
    partition.subscribers.set(subscriber.id, subscriber);
    return { partition, firstForHost };
  }

  unsubscribe(
    hostUrl: string,
    subscriberId: number,
  ): { hostRemoved: boolean; activeHostCount: number } {
    const partition = this.partitions.get(hostUrl);
    if (!partition) {
      return { hostRemoved: false, activeHostCount: this.partitions.size };
    }
    partition.subscribers.delete(subscriberId);
    if (partition.subscribers.size > 0) {
      return { hostRemoved: false, activeHostCount: this.partitions.size };
    }
    this.partitions.delete(hostUrl);
    this.disposeResource(partition.resource);
    return { hostRemoved: true, activeHostCount: this.partitions.size };
  }

  get(
    hostUrl: string,
  ): HostStreamPartition<Card, Event, Resource> | undefined {
    return this.partitions.get(hostUrl);
  }

  entries(): IterableIterator<
    [string, HostStreamPartition<Card, Event, Resource>]
  > {
    return this.partitions.entries();
  }

  get size(): number {
    return this.partitions.size;
  }

  isCurrent(partition: HostStreamPartition<Card, Event, Resource>): boolean {
    return this.partitions.get(partition.hostUrl) === partition;
  }

  applyIfCurrent(
    partition: HostStreamPartition<Card, Event, Resource>,
    apply: (partition: HostStreamPartition<Card, Event, Resource>) => void,
  ): boolean {
    if (!this.isCurrent(partition)) return false;
    apply(partition);
    return true;
  }

  replayInitialization(
    partition: HostStreamPartition<Card, Event, Resource>,
    subscriber: HostStreamSubscriber<Event>,
    createEvent: (cards: Card[]) => Event,
  ): boolean {
    if (!this.isCurrent(partition) || !partition.initialized) return false;
    subscriber.send(createEvent(partition.cards));
    return true;
  }

  broadcast(hostUrl: string, event: Event): void {
    const partition = this.partitions.get(hostUrl);
    if (!partition) return;
    this.broadcastPartition(partition, event);
  }

  broadcastPartition(
    partition: HostStreamPartition<Card, Event, Resource>,
    event: Event,
  ): boolean {
    if (!this.isCurrent(partition)) return false;
    for (const subscriber of partition.subscribers.values()) {
      try {
        subscriber.send(event);
      } catch {
        // A stream can disappear between delivery scheduling and enqueue.
      }
    }
    return true;
  }

  closeHost(
    hostUrl: string,
    expectedPartition?: HostStreamPartition<Card, Event, Resource>,
  ): void {
    const partition = this.partitions.get(hostUrl);
    if (!partition || (expectedPartition && partition !== expectedPartition)) {
      return;
    }
    this.partitions.delete(hostUrl);
    this.disposeResource(partition.resource);
    for (const subscriber of partition.subscribers.values()) {
      try {
        subscriber.close();
      } catch {
        // The client may already have closed its stream.
      }
    }
    partition.subscribers.clear();
  }
}
